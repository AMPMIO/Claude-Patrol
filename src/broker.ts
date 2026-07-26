#!/usr/bin/env bun
/**
 * claude-patrol broker daemon
 *
 * Singleton HTTP server on localhost:7900 backed by SQLite. Tracks registered
 * seats and routes messages between them. Ported from claude-peers-mcp
 * (feat/coalesce-metadata-auth): auth header, sender-context join on poll,
 * additive migrations, delivered-purge, stale-PID cleanup. Patrol additions:
 * profile + session_id columns and a /costs endpoint (per-seat spend).
 *
 * Auto-launched by the seat server if not already running. Run directly:
 *   bun src/broker.ts
 */
import { Database } from "bun:sqlite";
import { statSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { basename, resolve as resolvePath, isAbsolute } from "node:path";
import { getSecret, TOKEN_HEADER } from "../shared/auth.ts";
import {
  priceFor,
  projectDirName,
  sessionFiles,
  parseFileTail,
  resolveTokenToSession,
  findSessionIdByHeuristic,
  billingSourceFromEntrypoint,
  classifyCacheRebuild,
} from "./costs.ts";
import { randomBytes } from "node:crypto";
import { SEAT_TOKEN_RE, LEASE_TTL_SECONDS, LEASE_TOKEN_RE } from "../shared/types.ts";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListSeatsRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  AckRequest,
  UnregisterRequest,
  ObserveSessionRequest,
  CostsRequest,
  CostsResponse,
  CostRow,
  StatsRequest,
  StatsResponse,
  SeatStats,
  BoundVia,
  Seat,
  LogRequest,
  LogResponse,
  LogMessage,
  BillingSource,
  SeatState,
  SetStateRequest,
  ClaimPortRequest,
  ClaimPortResponse,
  ClaimPathRequest,
  ClaimPathResponse,
  ReleaseClaimsRequest,
  ListClaimsRequest,
  PathClaim,
  RenameRequest,
  RenameResponse,
  WaitForRequest,
  WaitForResponse,
  Question,
  AskRequest,
  AskResponse,
  QuestionsRequest,
  AnswerRequest,
  Worktree,
  WorktreeAddRequest,
  WorktreeListRequest,
  WorktreeRemoveRequest,
  LeaseWorktreeRequest,
  LeaseWorktreeResponse,
  ReleaseWorktreeRequest,
} from "../shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PATROL_PORT ?? "7900", 10);
// v0.2.4 /wait-for long-poll: re-check the target's state this often between reads,
// and never let a caller pin a request open longer than the cap. Poll is env-
// overridable so tests can tighten it.
const WAITFOR_POLL_MS = parseInt(process.env.CLAUDE_PATROL_WAITFOR_POLL_MS ?? "200", 10);
const WAITFOR_TIMEOUT_CAP_MS = 600_000;
const DB_PATH = process.env.CLAUDE_PATROL_DB ?? `${process.env.HOME}/.claude-patrol.db`;
const PROJECTS_ROOT = process.env.CLAUDE_PATROL_PROJECTS_ROOT; // undefined -> default below
const ROOT = PROJECTS_ROOT ?? `${process.env.HOME}/.claude/projects`;
// Background cost-index cadence. Low in tests so /costs reflects a just-written
// fixture within a poll; ~12s in production (mirrors cleanStaleSeats).
// 60s default (was 12s): indexTick re-walks + re-stats every fleet project dir
// and re-tails growing live logs each pass. On a large ~/.claude/projects
// (measured 1.8 GB / 2.4k jsonl during the dogfood week) a 12s cadence held a
// core near 50% continuously. 60s cuts that ~5x; the sweep-skip below takes it
// to idle when the fleet is quiet. Cost view is at most one interval stale.
const INDEX_INTERVAL_MS = parseInt(process.env.CLAUDE_PATROL_INDEX_INTERVAL_MS ?? "60000", 10);
const HOUR_MS = 3_600_000;
// v0.2.4 port allocation range [lo, hi] (inclusive). Seats claim from here so parallel
// dev servers never collide on localhost:3000. Overridable for tests.
const PORT_RANGE_LO = parseInt(process.env.CLAUDE_PATROL_PORT_RANGE_LO ?? "9000", 10);
const PORT_RANGE_HI = parseInt(process.env.CLAUDE_PATROL_PORT_RANGE_HI ?? "9099", 10);
// Bound a single claim so one request can't drain the whole range (or DoS the alloc scan).
const MAX_PORT_COUNT = 16;
// Bound a single path-claim batch (checklist #6 bounds-check).
const MAX_CLAIM_PATHS = 64;
// v0.2.3 lease/ack: how long a leased-but-unacked message waits before a LIVE consumer may
// re-lease it. Must exceed the codex adapter's 10-minute per-turn cap, or a slow-but-alive
// consumer would have its work redelivered underneath it. Overridable so a test can expire a
// lease without waiting 15 minutes (same pattern as INDEX_INTERVAL_MS).
//
// READ THIS BEFORE TRUSTING THE LEASE: it does NOT survive a consumer CRASH. cleanStaleSeats
// runs every 30s, sees the dead pid, and endSeat() DELETES that seat's undelivered mail long
// before this 15-minute lease could expire — and a restarted seat registers under a NEW slug,
// so its old mail is orphaned by to_id anyway. What the lease actually buys in v0.2.3 is
// narrower and still worth having: a live seat whose notification throws, or whose broker was
// briefly unreachable, redelivers instead of dropping; and a broker restart mid-flight
// redelivers. Real consumer-crash recovery needs stable seat identity across restarts, which
// is v0.3's capability tokens. Do not write crash-survival claims against this code.
const LEASE_TTL_MS = parseInt(process.env.CLAUDE_PATROL_LEASE_TTL_MS ?? String(15 * 60_000), 10);
const BROKER_START = new Date().toISOString();

function log(msg: string) {
  console.error(`[claude-patrol broker] ${msg}`);
}

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS seats (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    role TEXT,
    model TEXT,
    profile TEXT,
    session_id TEXT,
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

// Additive migrations for DBs created before a column existed. Each ALTER is
// idempotent-by-try: it throws (and is ignored) once the column is present.
// v0.2.4 adds `state` (self-reported seat state; NULL reads as "unknown" downstream)
// and `handle` (readable broker-assigned name; NULL on pre-0.2.4 rows => clients fall
// back to the hex id).
// v0.2.6 adds `budget_usd` (per-seat spend cap, NULL = no cap) and `budget_alerted`
// (0/1 latch so a crossing pings the recipient ONCE, not every index tick).
// v0.2.7 adds `budget_alert_to` (fleet PatrolConfig.budget_alert_to handle/role, NULL
// => the orchestrator default) so a crossing can page a configured recipient.
// v0.2.9 adds `guarded` (1 when the launcher installed the checkpoint-guard PreToolUse
// hook, so this seat's writes can actually be paused). NULL on pre-0.2.9 rows and on
// hand-launched seats, which reads as NOT guarded — `patrol checkpoint` refuses those
// rather than pretending a fence is a lease.
//
// `lease_file` is the LEASE_FILE_ENV path the SEAT reports at register, stored verbatim and
// echoed back by /list-seats. checkpoint cannot read the seat's env, so this relay is the
// only way it can write the file the guard hook stats. It is a PASS-THROUGH of the seat's
// own value, never a path derived here: a convention this broker invents that disagrees with
// the hook's means the hook never fires and the lease buys nothing. NULL => checkpoint
// treats the seat as unguarded rather than claim it is quiesced when it isn't.
for (const col of ["role TEXT", "model TEXT", "profile TEXT", "session_id TEXT", "state TEXT", "handle TEXT", "budget_usd REAL", "budget_alerted INTEGER NOT NULL DEFAULT 0", "budget_alert_to TEXT", "guarded INTEGER", "lease_file TEXT"]) {
  try {
    db.run(`ALTER TABLE seats ADD COLUMN ${col}`);
  } catch {
    // column already exists
  }
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  )
`);

// --- v0.2 cost attribution: durable seat-run history + a persisted ledger ---
// seat_runs outlives the live `seats` row (ended_at set on dereg), so a killed
// seat's spend still attributes; it also carries the token->session binding.
db.run(`
  CREATE TABLE IF NOT EXISTS seat_runs (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
    seat_id TEXT NOT NULL,
    session_id TEXT,
    seat_token TEXT,
    cwd TEXT NOT NULL,
    role TEXT,
    model TEXT,
    profile TEXT,
    registered_at TEXT NOT NULL,
    ended_at TEXT
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_seat_runs_session ON seat_runs(session_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_seat_runs_token ON seat_runs(seat_token)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_seat_runs_ended ON seat_runs(ended_at)`);

// Additive: which attribution layer bound this run's session_id (v0.2 telemetry).
// Written only when a binding is established; NULL until (and if) that happens.
for (const col of ["bound_via TEXT"]) {
  try {
    db.run(`ALTER TABLE seat_runs ADD COLUMN ${col}`);
  } catch {
    // column already exists
  }
}

// v0.2.3 lease/ack. Additive, same try/catch pattern: an existing db keeps its rows,
// and leased_at NULL reads as "never leased", which is exactly right for them.
for (const col of ["leased_at TEXT", "delivery_attempts INTEGER NOT NULL DEFAULT 0"]) {
  try {
    db.run(`ALTER TABLE messages ADD COLUMN ${col}`);
  } catch {
    // column already exists
  }
}

// Per (session, model, hour-bucket) token totals, carrying the attribution
// session (parent for subagents). /costs reads ONLY this table — no fs walk on
// the request path. attr_session_id joins to seat_runs.session_id for seat_id.
db.run(`
  CREATE TABLE IF NOT EXISTS cost_ledger (
    session_id TEXT NOT NULL,
    attr_session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    bucket_ts INTEGER NOT NULL,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, model, bucket_ts)
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_ledger_attr ON cost_ledger(attr_session_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_ledger_bucket ON cost_ledger(bucket_ts)`);
// v0.2.4 billing_source: which wallet a session's spend drew from, derived from
// the transcript entrypoint by the indexer (WP-M's billingSourceFromEntrypoint).
// Additive+default so pre-0.2.4 rows read as "subscription" — the interactive
// majority — until re-indexed. A session's rows only ever UPGRADE to agent-sdk
// (never downgrade), so an entrypoint-less line landing first can't mis-bill it.
// v0.3 cache tax: how much of this bucket's cache_write looked like a re-encode of an
// ALREADY-established prefix rather than a first-time one (costs.ts classifyCacheRebuild).
// Additive+default 0 so pre-0.3 rows read as "no rebuilds measured" — which is honest:
// they were never classified, and a zero here is "unknown", not "clean".
for (const col of [
  "billing_source TEXT NOT NULL DEFAULT 'subscription'",
  "cache_rebuilds INTEGER NOT NULL DEFAULT 0",
  "cache_rebuild_tokens INTEGER NOT NULL DEFAULT 0",
]) {
  try {
    db.run(`ALTER TABLE cost_ledger ADD COLUMN ${col}`);
  } catch {
    // column already exists
  }
}

// v0.2.4 local-resource claims. DISJOINT tables (checklist #8): nothing here
// touches the messages table or its leased_at delivery lease, despite the shared
// "claim" verb. Both are reaped by owner_id in endSeat.
db.run(`
  CREATE TABLE IF NOT EXISTS port_claims (
    port INTEGER PRIMARY KEY,
    owner_id TEXT NOT NULL,
    claimed_at TEXT NOT NULL
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_port_claims_owner ON port_claims(owner_id)`);
db.run(`
  CREATE TABLE IF NOT EXISTS path_claims (
    path TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    owner_role TEXT,
    claimed_at TEXT NOT NULL
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_path_claims_owner ON path_claims(owner_id)`);

// Per-file incremental cursor (bytes_parsed) + resume-rewrite dedupe. session_index
// persists across broker restarts, so a restart resumes tails instead of re-reading
// all history.
db.run(`
  CREATE TABLE IF NOT EXISTS session_index (
    file_path TEXT PRIMARY KEY,
    parent_session_id TEXT,
    bytes_parsed INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL
  )
`);
// Additive: hash of the bytes just before the parse cursor. Lets the indexer
// tell a plain append (anchor bytes intact -> tail parse) from an in-place
// rewrite (anchor bytes changed -> full reparse) when a file changed without
// shrinking. NULL for rows written before this column existed.
//
// session_ids: JSON array of the session id(s) this file has contributed to the
// ledger (one file == one session in practice; an array so a multi-session file
// is still expressible). On a reset (shrink/in-place rewrite) the indexer deletes
// the ledger + seen_msgs rows for these STORED ids, not just the ids in the newly
// parsed content — so a rewrite-to-empty, or a file whose session_id changed,
// still drops its prior contribution instead of orphaning stale (double-countable)
// rows. NULL for rows written before this column existed.
//
// max_cache_read: JSON {sessionId: largest cache_read seen so far}. The rebuild
// classifier needs "has this session already read a substantial prefix back?", and the
// indexer sees a session's records a few at a time across ticks — so that running max
// has to survive between ticks. Keyed by session because one file can carry more than
// one (a leaked max would fake a rebuild in the other session). Cleared on a reset,
// where the file is reparsed from byte 0 and the max is rebuilt from scratch.
for (const col of ["anchor_hash TEXT", "session_ids TEXT", "max_cache_read TEXT"]) {
  try {
    db.run(`ALTER TABLE session_index ADD COLUMN ${col}`);
  } catch {
    // column already exists
  }
}
db.run(`
  CREATE TABLE IF NOT EXISTS seen_msgs (
    session_id TEXT NOT NULL,
    msg_id TEXT NOT NULL,
    PRIMARY KEY (session_id, msg_id)
  )
`);

// One row per DELIVERED notification (a non-empty poll batch). batch_size is the
// coalesced message count in that single wake-up: messages/notifications is the
// coalescing ratio the README claims. check_messages fallback polls flow through
// the same handler and are logged too — they are paid context injections.
db.run(`
  CREATE TABLE IF NOT EXISTS delivery_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_id TEXT NOT NULL,
    batch_size INTEGER NOT NULL,
    delivered_at TEXT NOT NULL
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_delivery_log ON delivery_log(to_id, delivered_at)`);

// v0.2.5 question inbox. Additive (a fresh table never breaks an existing db, same
// as the seat_runs/cost_ledger CREATE-IF-NOT-EXISTS above). A seat raises a question
// the human must answer; /answer marks it and routes the answer back to the asking
// seat as a normal message. from_handle is snapshotted at ask time so a dead seat's
// answered history still renders a readable name. answered is 0/1 (SQLite has no bool).
db.run(`
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    from_handle TEXT,
    text TEXT NOT NULL,
    asked_at TEXT NOT NULL,
    answered INTEGER NOT NULL DEFAULT 0,
    answer TEXT,
    answered_at TEXT
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_questions_open ON questions(answered, id)`);

// v0.2.6 worktree association. Additive (same CREATE-IF-NOT-EXISTS idiom as the
// tables above). git is the source of truth for the tree; this table records ONLY
// the seat→worktree association so status/dashboard can show "seat → branch".
// PRIMARY KEY (seat_id, path) makes /worktree-add an idempotent upsert. Reaped by
// seat_id in endSeat — the ROW only; endSeat NEVER runs a git command, because a
// dead seat may hold unmerged work that only `patrol checkpoint` may integrate.
db.run(`
  CREATE TABLE IF NOT EXISTS worktrees (
    seat_id TEXT NOT NULL,
    path TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (seat_id, path)
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_worktrees_seat ON worktrees(seat_id)`);

// v0.2.9 checkpoint lease. Additive (same CREATE-IF-NOT-EXISTS idiom). This is MUTUAL
// EXCLUSION, not detection: while a lease is held the seat's PreToolUse guard hook denies
// its mutating tools, so `patrol checkpoint` merges against a quiesced tree instead of
// racing a standing writer. PRIMARY KEY (path) IS the exclusion — one lease per worktree,
// whoever holds it — so a renew by the holder is an upsert and a grab by anyone else hits
// the check in leaseWorktreeTxn. expires_at is load-bearing: a checkpoint killed between
// acquire and release must not wedge a seat forever, so an EXPIRED row blocks nobody (the
// hook fails open on staleness too). Reaped by seat_id in endSeat and by expiry in the
// stale sweep — a lease outliving its holder is the failure that makes locking worse than none.
db.run(`
  CREATE TABLE IF NOT EXISTS checkpoint_leases (
    seat_id TEXT NOT NULL,
    path TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (path)
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_leases_seat ON checkpoint_leases(seat_id)`);

// v0.2.9.1: the per-CHECKPOINT token (shared/types.ts LEASE_TOKEN_RE). Additive, same
// try/catch idiom as the other column adds. PRIMARY KEY (path) was the whole exclusion,
// but leaseWorktreeTxn treated a same-seat_id acquire as a RENEWAL — so `patrol
// checkpoint` twice on one seat gave BOTH processes a live lease, and either could
// release it out from under the other. The token is what makes the holder a specific RUN
// rather than a seat. A pre-0.2.9.1 row reads NULL and is treated as unrenewable and
// unreleasable-by-token; it still expires on its own, which is the safe direction.
try {
  db.run(`ALTER TABLE checkpoint_leases ADD COLUMN token TEXT`);
} catch {
  /* already present */
}

// v0.2.9 path aliasing fix. worktreeAddTxn compared raw path TEXT, so `/p/wt`, `/p/wt/`,
// `/p/x/../wt` and a symlink to it were four DIFFERENT paths — which restores the
// two-seats-one-worktree bug 0.2.8 closed for a single spelling. Canonicalize at the
// broker boundary instead, so the ownership check and the stored row always speak one name.
//
// realpathSync is the ONLY correct normalization here, and the reason existence is
// REQUIRED: lexically deleting a ".." segment resolves through a symlink to the WRONG
// directory (`/p/link/../wt` is not `/p/wt` when `link` points elsewhere), so a
// string-only fallback would quietly reintroduce the aliasing it is meant to close. A path
// that does not exist is not a worktree anyone can share, so refusing it costs nothing —
// every real caller records the association only after `git worktree add` created the tree.
function canonicalPath(p: string): string {
  if (!isAbsolute(p)) throw new Error(`path must be absolute: ${p}`);
  return realpathSync(p);
}

// The release/forget half. Those run AFTER the tree is gone (checkpoint removes the tree,
// then deregisters and drops its lease), so existence must NOT be required — falling back
// to the raw string keeps them idempotent instead of throwing on the happy path.
function canonicalPathOrRaw(p: string): string {
  try {
    return canonicalPath(p);
  } catch {
    return p;
  }
}

// Liveness probe: signal 0 doesn't kill, just checks existence. EPERM means the
// process EXISTS but is owned by another user, so it counts as alive (matches
// the CLI's pidAlive; moot for same-user seats but correct either way).
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Fully retire a seat, whatever the trigger (stale sweep, lazy drop in
// /list-seats, explicit /unregister). ONE definition so no removal path can
// forget a step: bound the run FIRST (keeps the row + its token->session binding
// for the /costs overlap join, so a killed seat's spend still attributes), then
// purge its undelivered mail (a dead seat's queue can never drain — those rows
// only bloat SQLite and orphan the run in every future stats window), then drop
// the live row. Uses inline SQL, not the prepared statements below, because it
// runs during module init (cleanStaleSeats) before those are declared.
function endSeat(seatId: string) {
  db.run("UPDATE seat_runs SET ended_at = ? WHERE seat_id = ? AND ended_at IS NULL", [
    new Date().toISOString(),
    seatId,
  ]);
  db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [seatId]);
  // Checklist #2/#4: reap the seat's resource claims HERE, the one removal path all
  // three reap triggers (stale sweep, list-seats lazy drop, unregister) funnel
  // through — so a port/path claim can never outlive its holder (a port allocated
  // forever, a path owned by a ghost). By owner_id, not FK cascade (#3: no FKs).
  db.run("DELETE FROM port_claims WHERE owner_id = ?", [seatId]);
  db.run("DELETE FROM path_claims WHERE owner_id = ?", [seatId]);
  // v0.2.5: drop this seat's OPEN questions — a dead seat can never receive the
  // answer, so the same reasoning as the undelivered-mail purge above applies. Its
  // ANSWERED history stays (answered=1 rows are untouched), so the inbox's answered
  // log survives the seat that asked.
  db.run("DELETE FROM questions WHERE from_id = ? AND answered = 0", [seatId]);
  // v0.2.6: drop this seat's worktree ASSOCIATIONS (rows only). git owns the tree —
  // a dead seat may hold unmerged work, so endSeat must NOT run `git worktree remove`
  // here (only `patrol checkpoint` removes a tree, and only after a clean merge). This
  // is exactly the frozen contract: endSeat forgets the association, never the tree.
  db.run("DELETE FROM worktrees WHERE seat_id = ?", [seatId]);
  // v0.2.9: drop this seat's checkpoint leases. A lease exists to quiesce a LIVE seat;
  // held by a dead one it only blocks the next checkpoint until the TTL burns down.
  db.run("DELETE FROM checkpoint_leases WHERE seat_id = ?", [seatId]);
  db.run("DELETE FROM seats WHERE id = ?", [seatId]);
}

// Clean up seats whose PID is gone; cap delivered-message table growth.
function cleanStaleSeats() {
  const seats = db.query("SELECT id, pid FROM seats").all() as { id: string; pid: number }[];
  for (const seat of seats) {
    if (!pidAlive(seat.pid)) endSeat(seat.id);
  }
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  db.run("DELETE FROM messages WHERE delivered = 1 AND sent_at < ?", [cutoff]);
  // Release leases a live seat never settled (its notification threw, or the broker was
  // briefly unreachable), so the message is offered again rather than sitting leased forever.
  // The poll itself also treats an expired lease as leasable, so this is belt-and-braces.
  // NOTE: this does NOT rescue a CRASHED consumer's mail — endSeat() above already deleted a
  // dead seat's undelivered rows on this same pass, and a restarted seat gets a new id. See
  // LEASE_TTL_MS.
  db.run("UPDATE messages SET leased_at = NULL WHERE delivered = 0 AND leased_at IS NOT NULL AND leased_at <= ?", [
    new Date(Date.now() - LEASE_TTL_MS).toISOString(),
  ]);
  // v0.2.9 checkpoint leases: an EXPIRED row blocks nobody (leaseWorktreeTxn ignores it,
  // and the seat's guard hook fails open past expiry), so this only stops the table from
  // accumulating dead rows. DISJOINT from the message lease above despite the shared verb.
  db.run("DELETE FROM checkpoint_leases WHERE expires_at <= ?", [new Date().toISOString()]);
}

cleanStaleSeats();
setInterval(cleanStaleSeats, 30_000);

// --- Prepared statements ---

const insertSeat = db.prepare(`
  INSERT INTO seats (id, pid, cwd, git_root, tty, summary, role, model, profile, session_id, registered_at, last_seen, handle, budget_usd, budget_alert_to, guarded, lease_file)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateLastSeen = db.prepare(`UPDATE seats SET last_seen = ? WHERE id = ?`);
const updateSummary = db.prepare(`UPDATE seats SET summary = ? WHERE id = ?`);
const updateState = db.prepare(`UPDATE seats SET state = ? WHERE id = ?`);
const updateHandle = db.prepare(`UPDATE seats SET handle = ? WHERE id = ?`);
const insertSeatRun = db.prepare(`
  INSERT INTO seat_runs (seat_id, session_id, seat_token, cwd, role, model, profile, registered_at, ended_at, bound_via)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
`);
const insertDelivery = db.prepare(`INSERT INTO delivery_log (to_id, batch_size, delivered_at) VALUES (?, ?, ?)`);
const upsertLedger = db.prepare(`
  INSERT INTO cost_ledger (session_id, attr_session_id, model, bucket_ts, input, output, cache_write, cache_read, billing_source, cache_rebuilds, cache_rebuild_tokens)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(session_id, model, bucket_ts) DO UPDATE SET
    input = input + excluded.input,
    output = output + excluded.output,
    cache_write = cache_write + excluded.cache_write,
    cache_read = cache_read + excluded.cache_read,
    cache_rebuilds = cache_rebuilds + excluded.cache_rebuilds,
    cache_rebuild_tokens = cache_rebuild_tokens + excluded.cache_rebuild_tokens,
    attr_session_id = excluded.attr_session_id,
    -- UPGRADE-ONLY: once any record proves a session is agent-sdk it stays so; a
    -- later entrypoint-less line must never downgrade it back to subscription.
    billing_source = CASE WHEN excluded.billing_source = 'agent-sdk' THEN 'agent-sdk' ELSE billing_source END
`);
const seenGet = db.prepare(`SELECT 1 FROM seen_msgs WHERE session_id = ? AND msg_id = ?`);
const seenIns = db.prepare(`INSERT OR IGNORE INTO seen_msgs (session_id, msg_id) VALUES (?, ?)`);
const idxGet = db.prepare(`SELECT bytes_parsed, mtime_ms, anchor_hash, session_ids, max_cache_read FROM session_index WHERE file_path = ?`);
const idxSet = db.prepare(`INSERT OR REPLACE INTO session_index (file_path, parent_session_id, bytes_parsed, mtime_ms, anchor_hash, session_ids, max_cache_read) VALUES (?, ?, ?, ?, ?, ?, ?)`);
const selectAllSeats = db.prepare(`SELECT * FROM seats`);
const selectSeatsByDirectory = db.prepare(`SELECT * FROM seats WHERE cwd = ?`);
const selectSeatsByGitRoot = db.prepare(`SELECT * FROM seats WHERE git_root = ?`);
const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?, ?, ?, ?, 0)
`);
// v0.2.3: a poll LEASES. Rows already leased by a live consumer are skipped — returning
// them would hand the same message to two consumers. A lease older than LEASE_TTL is
// treated as abandoned (the consumer died mid-work) and becomes leasable again, so the
// message redelivers instead of being lost. LEASE_TTL exceeds the codex adapter's 10-minute
// per-turn cap, so a slow-but-alive consumer is never treated as dead.
// A batch nobody can ack must not wake-and-bill a seat forever. After MAX_DELIVERY_ATTEMPTS
// leases the row is dead-lettered: it stops being handed out and stops logging wake-ups, but
// it is NOT deleted — it stays visible to /log as undelivered, which is the evidence you want
// when asking why a seat never answered. Unbounded redelivery would also corrupt the
// coalescing and cost telemetry that is this project's whole differentiator.
const MAX_DELIVERY_ATTEMPTS = 3;
const selectLeasable = db.prepare(`
  SELECT m.id, m.from_id, m.to_id, m.text, m.sent_at, m.delivered,
         s.summary AS from_summary, s.cwd AS from_cwd,
         s.role AS from_role, s.model AS from_model
  FROM messages m LEFT JOIN seats s ON s.id = m.from_id
  WHERE m.to_id = ? AND m.delivered = 0
    AND (m.leased_at IS NULL OR m.leased_at <= ?)
    AND m.delivery_attempts < ?
  ORDER BY m.sent_at ASC
`);
const leaseMessage = db.prepare(`UPDATE messages SET leased_at = ?, delivery_attempts = delivery_attempts + 1 WHERE id = ?`);
// Ack is scoped to the recipient: a seat can only settle its OWN mail, so a foreign or
// unknown id updates nothing. Re-acking an already-delivered row is a no-op, which makes
// a duplicate ack (retry, double push) harmless.
const ackMessage = db.prepare(`UPDATE messages SET delivered = 1 WHERE id = ? AND to_id = ?`);

// Message history for `patrol watch` (/log). Sender AND recipient role/model come
// from the LATEST seat_runs row per seat_id (runs persist past dereg, so a dead
// seat still resolves; a "cli" from_id has no run and yields nulls). Delivered
// and undelivered rows both included; ordered by id so a cursor (after_id) tails.
const selectLog = db.prepare(`
  WITH latest_run AS (
    SELECT seat_id, role, model,
           ROW_NUMBER() OVER (PARTITION BY seat_id ORDER BY run_id DESC) AS rn
    FROM seat_runs
  )
  SELECT m.id, m.from_id, m.to_id, m.text, m.sent_at, m.delivered,
         fr.role AS from_role, fr.model AS from_model,
         tr.role AS to_role, tr.model AS to_model
  FROM messages m
  LEFT JOIN latest_run fr ON fr.seat_id = m.from_id AND fr.rn = 1
  LEFT JOIN latest_run tr ON tr.seat_id = m.to_id AND tr.rn = 1
  WHERE m.id > ?
  ORDER BY m.id ASC
  LIMIT ?
`);
const selectMaxMsgId = db.prepare(`SELECT MAX(id) AS mx FROM messages`);

// v0.2.5 question inbox statements.
const insertQuestion = db.prepare(
  `INSERT INTO questions (from_id, from_handle, text, asked_at, answered) VALUES (?, ?, ?, ?, 0)`
);
const selectOpenQuestions = db.prepare(
  `SELECT id, from_id, from_handle, text, asked_at, answered, answer, answered_at FROM questions WHERE answered = 0 ORDER BY id DESC`
);
const selectAllQuestions = db.prepare(
  `SELECT id, from_id, from_handle, text, asked_at, answered, answer, answered_at FROM questions ORDER BY id DESC`
);
const selectQuestionById = db.prepare(`SELECT id, from_id, answered FROM questions WHERE id = ?`);
const markAnswered = db.prepare(`UPDATE questions SET answered = 1, answer = ?, answered_at = ? WHERE id = ?`);

// v0.2.6 worktree association statements. Upsert keeps /worktree-add idempotent on
// (seat_id, path): a re-record of the same worktree refreshes branch/base, never dups.
const upsertWorktree = db.prepare(
  `INSERT INTO worktrees (seat_id, path, branch, base_commit, created_at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(seat_id, path) DO UPDATE SET branch = excluded.branch, base_commit = excluded.base_commit, created_at = excluded.created_at`
);
// v0.2.9: lease_expires_at rides along (additive — the frozen Worktree contract predates
// it, so clients read it off a widened view, same as status.ts does for budget_usd). It is
// what makes a held lease VISIBLE: a checkpoint that died before releasing is otherwise a
// seat that mysteriously refuses to write until the TTL burns down.
const selectWorktreesBySeat = db.prepare(
  `SELECT w.seat_id, w.path, w.branch, w.base_commit, w.created_at, l.expires_at AS lease_expires_at
   FROM worktrees w LEFT JOIN checkpoint_leases l ON l.path = w.path
   WHERE w.seat_id = ? ORDER BY w.created_at`
);
const selectAllWorktrees = db.prepare(
  `SELECT w.seat_id, w.path, w.branch, w.base_commit, w.created_at, l.expires_at AS lease_expires_at
   FROM worktrees w LEFT JOIN checkpoint_leases l ON l.path = w.path ORDER BY w.created_at`
);
const deleteWorktree = db.prepare(`DELETE FROM worktrees WHERE seat_id = ? AND path = ?`);
// v0.2.7.1: who (if anyone) already holds this PATH, regardless of seat. The handle is
// joined in so the rejection can name a human-readable owner; LEFT JOIN because the
// seat row may have been reaped while the association lingers.
//
// v0.2.9 drops the LIMIT 1: a db written before path canonicalization may hold SEVERAL
// rows for one tree under different spellings, and a lookup that reports only the first
// owner is how that state stays invisible. Those legacy rows are deliberately NOT migrated
// or de-duplicated — `CREATE UNIQUE INDEX` would fail at startup for exactly the users the
// bug hit — so callers detect the multi-owner case and stop for a human instead.
const selectWorktreeOwnersByPath = db.prepare(
  `SELECT w.seat_id AS seat_id, s.handle AS handle FROM worktrees w
   LEFT JOIN seats s ON s.id = w.seat_id WHERE w.path = ?`
);

// v0.2.9 checkpoint lease statements. The upsert is keyed on PATH (the table's PK), so the
// HOLDER renewing refreshes expiry in place; a different seat never reaches it (the txn
// below refuses first). Delete is owner-scoped by seat_id AND matches either spelling —
// the caller may release after the tree is gone, when realpath can no longer canonicalize.
const upsertLease = db.prepare(
  `INSERT INTO checkpoint_leases (seat_id, path, expires_at, created_at, token) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(path) DO UPDATE SET seat_id = excluded.seat_id, expires_at = excluded.expires_at, token = excluded.token`
);
const selectLeaseByPath = db.prepare(
  `SELECT l.seat_id AS seat_id, l.expires_at AS expires_at, l.token AS token, s.handle AS handle
   FROM checkpoint_leases l LEFT JOIN seats s ON s.id = l.seat_id WHERE l.path = ?`
);
// v0.2.9.1: release is scoped by TOKEN, not seat_id. Scoping by seat let a second
// checkpoint of the same seat delete the first one's lease mid-merge. Still matches
// either path spelling — the caller may release after the tree is gone, when realpath
// can no longer canonicalize.
const deleteLease = db.prepare(`DELETE FROM checkpoint_leases WHERE token = ? AND path IN (?, ?)`);

// --- Seat ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// v0.2.4 readable handle. A UX layer ON TOP of the immutable hex id — never a
// replacement, and never a unique KEY (the id is). slug() lowercases to [a-z0-9-],
// collapses repeats, trims dashes, and CAPS length so a long name can't blow out
// the status/list tables or the watch SEAT column; empty degrades to "seat".
const HANDLE_MAX = 24;
function slug(s: string | null | undefined): string {
  const out = (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // Cap AT the source, then re-trim so the cut never leaves a trailing dash.
  return out.slice(0, HANDLE_MAX).replace(/-+$/g, "") || "seat";
}

// The hex id shape (SLUG_RE): exactly 8 chars of [a-z0-9]. A handle must NEVER take
// this shape, or it would live in the id namespace and shadow a real seat's id in
// resolveSeatTarget (which checks exact-handle before exact-id).
function looksLikeSeatId(s: string): boolean {
  return /^[a-z0-9]{8}$/.test(s);
}

// A handle is "taken" only if a LIVE seat OTHER than excludeId holds it — dead
// seats free their handle (and it's reaped from the row on endSeat anyway).
function handleTaken(handle: string, excludeId: string): boolean {
  const rows = db.query("SELECT pid FROM seats WHERE handle = ? AND id != ?").all(handle, excludeId) as { pid: number }[];
  return rows.some((r) => pidAlive(r.pid));
}

// Assign a stable readable handle, deduped among live seats AND kept out of the id
// namespace (MED-1):
//   base            when free AND not id-shaped,
//   base-<proj>     else (proj = slug of the git-root/cwd basename),
//   base-<4hex>     else (last resort; 4 chars of the seat's own id — the id is
//                   always the unambiguous fallback, so a residual collision here
//                   never routes to the wrong seat, it just reads less prettily).
// The suffixed forms all contain a dash, so they can never be 8-pure-alnum — only
// the bare `base` could collide with the id space, so that's the branch we guard.
function assignHandle(baseName: string | null | undefined, ownId: string, gitRoot: string | null, cwd: string): string {
  const base = slug(baseName);
  if (!looksLikeSeatId(base) && !handleTaken(base, ownId)) return base;
  const proj = slug(basename(gitRoot || cwd)).slice(0, 8).replace(/-+$/g, "") || "seat";
  const withProj = `${base}-${proj}`;
  if (!handleTaken(withProj, ownId)) return withProj;
  return `${base}-${ownId.slice(0, 4)}`;
}

// --- Handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();
  // Re-registration for the same PID replaces the prior row. Full retirement via
  // endSeat (not a bare row delete): the old seat_id is discarded — a fresh id is
  // generated above — so any mail still queued to it can never be polled or swept
  // and would linger forever (and render as phantom rows in /log). endSeat bounds
  // the run, purges that undelivered mail, and drops the row; deleting the row
  // also lets a seat reclaim its own session_id below without colliding with itself.
  const existing = db.query("SELECT id FROM seats WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) endSeat(existing.id);

  // Uniqueness guard: a session_id already held by a LIVE seat must not be
  // claimed twice — two same-cwd seats racing the mtime heuristic would else
  // misattribute costs. Ambiguity degrades to null (dark spend beats wrong spend).
  let sessionId = body.session_id ?? null;
  let rejected = false;
  if (sessionId) {
    const holders = db.query("SELECT pid FROM seats WHERE session_id = ?").all(sessionId) as { pid: number }[];
    if (holders.some((h) => pidAlive(h.pid))) {
      sessionId = null;
      rejected = true;
    }
  }

  // Readable handle, deduped among live seats. Base is the requested name, else the
  // role, else "seat". Computed AFTER the same-pid endSeat above, so a re-register
  // doesn't collide with the row it just retired.
  const handle = assignHandle(body.name ?? body.role, id, body.git_root, body.cwd);

  insertSeat.run(
    id, body.pid, body.cwd, body.git_root, body.tty, body.summary,
    body.role ?? null, body.model ?? null, body.profile ?? null, sessionId,
    now, now, handle, body.budget_usd ?? null, body.budget_alert_to ?? null,
    // v0.2.9: SQLite has no bool. Absent/null => 0 (NOT guarded) — the safe read, since
    // checkpoint refuses an unguarded seat rather than assume it can be quiesced.
    body.guarded ? 1 : 0,
    // Stored verbatim — the SEAT owns this path (it is what it was handed in LEASE_FILE_ENV).
    body.lease_file ?? null
  );

  // Durable run row (survives dereg). session_id is the env-override/guarded
  // fast path; when null the indexer resolves it later via the seat token
  // (Layer 1) or heuristic (Layer 3). Invalid tokens degrade to null.
  const seatToken = body.seat_token && SEAT_TOKEN_RE.test(body.seat_token) ? body.seat_token : null;
  insertSeatRun.run(
    id, sessionId, seatToken, body.cwd,
    body.role ?? null, body.model ?? null, body.profile ?? null, now,
    // session_id present at register-time == the env/session_id fast path bound it.
    sessionId ? "env" : null
  );

  return rejected ? { id, session_id_rejected: true } : { id };
}

function handleListSeats(body: ListSeatsRequest): Seat[] {
  let seats: Seat[];
  switch (body.scope) {
    case "directory":
      seats = selectSeatsByDirectory.all(body.cwd) as Seat[];
      break;
    case "repo":
      seats = body.git_root
        ? (selectSeatsByGitRoot.all(body.git_root) as Seat[])
        : (selectSeatsByDirectory.all(body.cwd) as Seat[]);
      break;
    case "machine":
    default:
      seats = selectAllSeats.all() as Seat[];
  }
  if (body.exclude_id) seats = seats.filter((s) => s.id !== body.exclude_id);
  // Drop seats whose process has died since last cleanup tick. Full retirement
  // (endSeat), not a bare row delete: `patrol status` right after a seat dies
  // must not leave the run unbounded or its undelivered mail behind.
  // v0.2.9: SQLite stores `guarded` as 0/1, but Seat.guarded is a BOOLEAN — normalize here so
  // no client has to remember that a raw 0 from the driver is truthy. `lease_file` passes
  // through as the TEXT/NULL it already is.
  return seats
    .filter((s) => {
      if (pidAlive(s.pid)) return true;
      endSeat(s.id);
      return false;
    })
    .map((s) => ({ ...s, guarded: !!s.guarded }));
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  // Identity partial (security Fix 5-lite): a from_id that isn't a LIVE seat or
  // the literal "cli" is forged provenance — reject explicitly instead of
  // delivering with silently blank sender metadata (the LEFT JOIN case).
  if (body.from_id !== "cli") {
    const sender = db.query("SELECT pid FROM seats WHERE id = ?").get(body.from_id) as { pid: number } | null;
    if (!sender || !pidAlive(sender.pid)) {
      return { ok: false, error: `from_id ${body.from_id} is not a live seat (or "cli")` };
    }
  }
  const target = db.query("SELECT id FROM seats WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) return { ok: false, error: `Seat ${body.to_id} not found` };
  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

// The select-then-lease pair is ONE atomic claim, enforced two ways: it runs inside a
// db.transaction (structural), and this handler stays SYNCHRONOUS (no await can interleave).
// DO NOT MAKE THIS ASYNC even with the transaction: two concurrent polls — the push loop and
// a check_messages call — must never select the same rows before either leases them, or the
// batch is handed out twice, double-waking a seat and billing it twice. Nothing fails loudly
// when that happens; it just quietly costs money.
const claimBatch = db.transaction((seatId: string, expiry: string, leasedAt: string) => {
  const rows = selectLeasable.all(seatId, expiry, MAX_DELIVERY_ATTEMPTS) as PollMessagesResponse["messages"];
  for (const m of rows) leaseMessage.run(leasedAt, m.id);
  return rows;
});

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const now = Date.now();
  const expiry = new Date(now - LEASE_TTL_MS).toISOString();
  const leasedAt = new Date(now).toISOString();
  const rows = claimBatch(body.id, expiry, leasedAt);
  // A non-empty batch is exactly one delivered notification == one paid wake-up; batch_size
  // is the coalesced message count. Empty polls log nothing (no notification fired). This is
  // the coalescing evidence /stats reports. A re-lease logs again, correctly — it woke the
  // seat a second time and was paid for twice — which is exactly why MAX_DELIVERY_ATTEMPTS
  // exists: an unackable batch that redelivered forever would inflate this telemetry without
  // bound.
  if (rows.length > 0) insertDelivery.run(body.id, rows.length, leasedAt);
  // Leased, NOT delivered: the row is delivered only when the consumer /ack's it, after the
  // message is out. v0.2.2 reported delivered=true here, and that lie is what let a failed
  // push drop a message silently.
  return { messages: rows.map((m) => ({ ...m, delivered: false })) };
}

// Settle a leased batch. Called by a consumer only AFTER the message is durably out (the
// channel notification resolved, or the tool returned it to the model) — that ordering is
// the whole point: a consumer that dies before this leaves the lease to expire and the
// message to redeliver.
function handleAck(body: AckRequest): { ok: true } {
  for (const id of body.message_ids) ackMessage.run(id, body.id);
  return { ok: true };
}

// Idempotent dereg: by explicit id (seat-server shutdown) or by pid (SessionEnd
// hook, which knows only its $PPID). A no-match is not an error — the hook may
// fire after stale-PID cleanup already removed the row.
function handleUnregister(body: UnregisterRequest): void {
  let id = body.id;
  if (!id && body.pid != null) {
    const row = db.query("SELECT id FROM seats WHERE pid = ?").get(body.pid) as { id: string } | null;
    id = row?.id;
  }
  if (id) endSeat(id);
}

// --- v0.2.4 seat state + local-resource claims ---

// A claim/state owner must be a LIVE seat, so a claim can be reaped by endSeat when
// it dies (checklist #2/#3: no orphan owned by a ghost). Mirrors send-message's
// from_id liveness guard. Returns the seat row (with role) or null.
function liveSeat(id: string): { pid: number; role: string | null } | null {
  const s = db.query("SELECT pid, role FROM seats WHERE id = ?").get(id) as { pid: number; role: string | null } | null;
  return s && pidAlive(s.pid) ? s : null;
}

// A seat reports its OWN state (the request's `id` IS the seat — the frozen
// SetStateRequest carries no separate caller/target, unlike /wait-for). The update
// touches ONLY that row, and only when it's a live seat, so no seat can invent a
// state for a nonexistent id or bleed into another row. Reaped for free: `state` is
// a column on the seats row endSeat already deletes.
function handleSetState(body: SetStateRequest): { ok: boolean; error?: string } {
  if (!liveSeat(body.id)) return { ok: false, error: `${body.id} is not a live seat` };
  updateState.run(body.state, body.id);
  return { ok: true };
}

// /wait-for: block until `target` reaches any state in `until`, or timeout_ms
// elapses. A read-WAIT, not a check-then-write — so it holds NO db transaction while
// waiting; each iteration is an INDEPENDENT sync read, and the await between reads
// yields the single Bun thread so other handlers (a concurrent /list-seats) still
// respond. A target that no longer exists or whose pid is dead resolves immediately
// (reached:false, "unknown") rather than hanging. NEVER mutates state.
async function handleWaitFor(body: WaitForRequest): Promise<WaitForResponse> {
  const until = new Set<SeatState>(body.until);
  const deadline = Date.now() + Math.min(body.timeout_ms, WAITFOR_TIMEOUT_CAP_MS);
  for (;;) {
    const row = db.query("SELECT pid, state FROM seats WHERE id = ?").get(body.target) as { pid: number; state: string | null } | null;
    // Gone or dead: don't wait on a seat that can never report again.
    if (!row || !pidAlive(row.pid)) return { reached: false, state: "unknown" };
    const state = (row.state as SeatState | null) ?? "unknown";
    if (until.has(state)) return { reached: true, state };
    if (Date.now() >= deadline) return { reached: false, state }; // timed out — carry last-known state
    await new Promise((resolve) => setTimeout(resolve, WAITFOR_POLL_MS));
  }
}

// Explicit rename: re-slug + re-dedupe the requested name and store it. Returns the
// ACTUAL assigned handle (a "-proj"/"-hex" suffix on collision), never the raw input.
// Owner-scoped by body.id — same trust model as /set-state (the v0.3 capability-token
// gate covers spoofing later; the existing pattern is not re-invented here).
function handleRename(body: RenameRequest): RenameResponse | { ok: false; error: string } {
  const seat = db.query("SELECT pid, cwd, git_root FROM seats WHERE id = ?").get(body.id) as { pid: number; cwd: string; git_root: string | null } | null;
  if (!seat || !pidAlive(seat.pid)) return { ok: false, error: `${body.id} is not a live seat` };
  const handle = assignHandle(body.name, body.id, seat.git_root, seat.cwd);
  updateHandle.run(handle, body.id);
  return { ok: true, handle };
}

// Allocate `count` free ports from [LO, HI], PERSISTED in port_claims (checklist
// #4: no in-process Set — it dies on restart while a live seat's env still points
// at the port). ONE db.transaction, handler stays SYNCHRONOUS (checklist #1: no
// await between the free-scan and the insert, or two claims interleave onto one
// port). The whole allocation is atomic — a partial claim never persists.
const claimPortsTxn = db.transaction((ownerId: string, count: number, now: string): number[] => {
  const taken = new Set(
    (db.query("SELECT port FROM port_claims").all() as { port: number }[]).map((r) => r.port)
  );
  const allocated: number[] = [];
  for (let p = PORT_RANGE_LO; p <= PORT_RANGE_HI && allocated.length < count; p++) {
    if (taken.has(p)) continue;
    db.run("INSERT INTO port_claims (port, owner_id, claimed_at) VALUES (?, ?, ?)", [p, ownerId, now]);
    allocated.push(p);
  }
  if (allocated.length < count) {
    // Not enough free ports: abort the WHOLE allocation (throw rolls the transaction
    // back) so a seat never boots with a half-satisfied port set.
    throw new Error(`port range ${PORT_RANGE_LO}-${PORT_RANGE_HI} exhausted: ${count} requested, ${allocated.length} free`);
  }
  return allocated;
});

function handleClaimPort(body: ClaimPortRequest): ClaimPortResponse {
  if (!liveSeat(body.id)) throw new Error(`${body.id} is not a live seat`);
  const count = body.count ?? 1;
  return { ports: claimPortsTxn(body.id, count, new Date().toISOString()) };
}

// Absolute + realpath-resolved (contract). realpath collapses symlinks so two
// spellings of one file can't be double-claimed; it throws on a not-yet-existing
// path, so fall back to a plain absolute resolve for a claim on a file about to be
// created (advisory claims are allowed ahead of the file existing).
function normalizeClaimPath(p: string): string {
  const abs = resolvePath(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

// Check-then-insert for a whole batch in ONE db.transaction (checklist #1): a path
// held by ANOTHER owner is denied with the current holder (advisory — no theft,
// checklist #6 authz); a free path, or one this seat already holds, is granted
// (idempotent re-claim).
const claimPathsTxn = db.transaction((ownerId: string, ownerRole: string | null, paths: string[], now: string) => {
  const granted: string[] = [];
  const denied: PathClaim[] = [];
  for (const raw of paths) {
    const path = normalizeClaimPath(raw);
    const holder = db.query("SELECT path, owner_id, owner_role, claimed_at FROM path_claims WHERE path = ?").get(path) as PathClaim | null;
    if (holder && holder.owner_id !== ownerId) {
      denied.push(holder);
      continue;
    }
    db.run(
      `INSERT INTO path_claims (path, owner_id, owner_role, claimed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET claimed_at = excluded.claimed_at, owner_role = excluded.owner_role`,
      [path, ownerId, ownerRole, now]
    );
    granted.push(path);
  }
  return { granted, denied };
});

function handleClaimPath(body: ClaimPathRequest): ClaimPathResponse {
  const seat = liveSeat(body.id);
  if (!seat) throw new Error(`${body.id} is not a live seat`);
  return claimPathsTxn(body.id, seat.role, body.paths, new Date().toISOString());
}

// Release only your OWN claims (checklist #6: a seat can't release another's).
// paths given => release just those you hold; omitted => release everything you
// hold. Idempotent: releasing a path you don't own matches nothing.
function handleReleaseClaims(body: ReleaseClaimsRequest): { ok: true } {
  if (body.paths && body.paths.length > 0) {
    for (const raw of body.paths) {
      db.run("DELETE FROM path_claims WHERE path = ? AND owner_id = ?", [normalizeClaimPath(raw), body.id]);
    }
  } else {
    db.run("DELETE FROM path_claims WHERE owner_id = ?", [body.id]);
  }
  return { ok: true };
}

// Advisory read of current path claims. git_root scopes to claims on paths under
// that repo root (prefix match); omitted => all claims. Raw rows — the caller
// coordinates. (Port claims are lifecycle-only, reaped in endSeat, no read route.)
function handleListClaims(body: ListClaimsRequest): PathClaim[] {
  const rows = body.git_root
    ? (db.query(
        "SELECT path, owner_id, owner_role, claimed_at FROM path_claims WHERE path = ? OR path LIKE ? ORDER BY path"
      ).all(body.git_root, `${body.git_root}/%`) as PathClaim[])
    : (db.query("SELECT path, owner_id, owner_role, claimed_at FROM path_claims ORDER BY path").all() as PathClaim[]);
  return rows;
}

// v0.2 Layer 2 (exact; any seat incl. manual): a plugin SessionStart hook posts
// what CC hands it. Bind the session to the live run whose claude pid matches
// (seats.pid is now the claude pid — see seat-server), else the newest still-
// unbound live run in the same cwd. Idempotent: re-binding the same value or a
// run that already has a session is a no-op. Called by plugin/hooks/reg-session.ts
// (SessionStart), which posts CC's session_id + transcript_path for the seat.
function handleObserveSession(body: ObserveSessionRequest): { ok: boolean } {
  if (!body.session_id) return { ok: false };
  const sid = body.session_id;

  // COALESCE keeps an already-set bound_via (a prior layer's binding wins the
  // label); only a run bound HERE for the first time is tagged "observe".
  const bind = (runId: number) =>
    db.run("UPDATE seat_runs SET session_id = ?, bound_via = COALESCE(bound_via, 'observe') WHERE run_id = ?", [sid, runId]);

  // Never-misattribute guard: this session must not already belong to a
  // DIFFERENT OPEN run. Two LIVE runs claiming one session would double-attribute
  // its spend. An ENDED run's session, though, is fair game to re-bind: a
  // restarted seat resuming the same CC session must be able to claim it, and
  // readLedgerWindow's last-run-wins then attributes the overlap to the newest run.
  const ownedByOther = (exceptRunId: number): boolean =>
    !!db.query("SELECT 1 FROM seat_runs WHERE session_id = ? AND run_id != ? AND ended_at IS NULL").get(sid, exceptRunId);

  // Primary: the live run whose claude pid matches (seats.pid is the claude pid).
  const byPid = db.query(
    "SELECT sr.run_id, sr.session_id FROM seat_runs sr JOIN seats s ON s.id = sr.seat_id WHERE s.pid = ? AND sr.ended_at IS NULL ORDER BY sr.registered_at DESC"
  ).get(body.claude_pid) as { run_id: number; session_id: string | null } | null;
  if (byPid) {
    if (byPid.session_id === sid) return { ok: true }; // idempotent re-post: no change
    if (byPid.session_id !== null) return { ok: false }; // already bound to another session — never overwrite
    if (ownedByOther(byPid.run_id)) return { ok: false }; // some other run owns this session
    bind(byPid.run_id);
    return { ok: true };
  }

  // Fallback: bind ONLY when EXACTLY ONE unbound, live run sits in this cwd.
  // Zero or several is ambiguous — degrade to unbound (token/heuristic layers or
  // a later observe can still bind it) rather than guess which run to charge.
  const candidates = (
    db.query(
      "SELECT sr.run_id, s.pid FROM seat_runs sr JOIN seats s ON s.id = sr.seat_id WHERE sr.cwd = ? AND sr.session_id IS NULL AND sr.ended_at IS NULL"
    ).all(body.cwd) as { run_id: number; pid: number }[]
  ).filter((r) => pidAlive(r.pid));
  if (candidates.length !== 1) return { ok: false };
  const run = candidates[0]!;
  if (ownedByOther(run.run_id)) return { ok: false };
  bind(run.run_id);
  return { ok: true };
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

// One (session, model) tally of ledger spend, carrying the attribution session
// that maps it to a seat. Displayed by its OWN session_id; attributed by attr.
interface LedgerTally {
  session_id: string;
  attr_session_id: string;
  model: string;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  cache_rebuilds: number;
  cache_rebuild_tokens: number;
  billing_source: BillingSource;
}

// Shared window read for /costs AND /stats. Table reads ONLY — no filesystem
// walk on the request path (that O(all-history) scan was the flagship-view
// latency bug); spend is at most one index tick stale. Window filtering is at
// hour-bucket granularity (the ledger's resolution): a sub-hour `since`/`until`
// is floored to its bucket. Both endpoints MUST consume the same tallies + the
// same attr_session_id -> seat_id map so /stats can never disagree with /costs
// on a seat's spend (see handleStats).
function readLedgerWindow(body: { since?: string; until?: string }): {
  sinceIso: string;
  untilIso: string | null;
  tallies: LedgerTally[];
  seatBySession: Map<string, string>;
} {
  const sinceIso = body.since ?? BROKER_START;
  const untilIso = body.until ?? null;
  const sinceMs = Date.parse(sinceIso);
  const sinceBucket = Number.isNaN(sinceMs) ? 0 : Math.floor(sinceMs / HOUR_MS) * HOUR_MS;
  const untilMs = untilIso ? Date.parse(untilIso) : null;
  const untilBucket = untilMs !== null && !Number.isNaN(untilMs) ? Math.floor(untilMs / HOUR_MS) * HOUR_MS : null;

  // attr_session_id -> seat_id from runs overlapping [since, until], INCLUDING
  // ended runs (killed-seat history still attributes). ISO-8601 UTC strings sort
  // chronologically, so the overlap compares as plain string bounds. ASC + last
  // write wins => a restarted session binds to its most recent run.
  const runs = db.query(
    `SELECT seat_id, session_id FROM seat_runs
     WHERE session_id IS NOT NULL AND registered_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
     ORDER BY registered_at ASC`
  ).all(untilIso ?? "9999", sinceIso) as { seat_id: string; session_id: string }[];
  const seatBySession = new Map<string, string>();
  for (const r of runs) seatBySession.set(r.session_id, r.seat_id);

  const ledger = (
    untilBucket !== null
      ? db.query(
          `SELECT session_id, attr_session_id, model, input, output, cache_write, cache_read, billing_source,
                  cache_rebuilds, cache_rebuild_tokens
           FROM cost_ledger WHERE bucket_ts >= ? AND bucket_ts <= ?`
        ).all(sinceBucket, untilBucket)
      : db.query(
          `SELECT session_id, attr_session_id, model, input, output, cache_write, cache_read, billing_source,
                  cache_rebuilds, cache_rebuild_tokens
           FROM cost_ledger WHERE bucket_ts >= ?`
        ).all(sinceBucket)
  ) as {
    session_id: string; attr_session_id: string; model: string;
    input: number; output: number; cache_write: number; cache_read: number; billing_source: BillingSource | null;
    cache_rebuilds: number | null; cache_rebuild_tokens: number | null;
  }[];

  // collapse hour buckets into one tally per (session, model).
  const tally = new Map<string, LedgerTally>();
  for (const r of ledger) {
    const key = `${r.session_id}\0${r.model}`;
    let t = tally.get(key);
    if (!t) {
      t = { session_id: r.session_id, attr_session_id: r.attr_session_id, model: r.model, input: 0, output: 0, cache_write: 0, cache_read: 0, cache_rebuilds: 0, cache_rebuild_tokens: 0, billing_source: "subscription" };
      tally.set(key, t);
    }
    t.input += r.input;
    t.output += r.output;
    t.cache_write += r.cache_write;
    t.cache_read += r.cache_read;
    // NULL on a pre-0.3 row (never classified) reads as 0 — an under-count, not a
    // fabricated clean bill.
    t.cache_rebuilds += r.cache_rebuilds ?? 0;
    t.cache_rebuild_tokens += r.cache_rebuild_tokens ?? 0;
    // Upgrade-only, defensive: any agent-sdk bucket makes the tally agent-sdk (a NULL
    // from a pre-0.2.4 row reads as subscription). Mirrors the ledger's ON CONFLICT.
    if (r.billing_source === "agent-sdk") t.billing_source = "agent-sdk";
  }
  return { sinceIso, untilIso, tallies: [...tally.values()], seatBySession };
}

function costOf(t: { model: string; input: number; output: number; cache_write: number; cache_read: number }): number {
  const [pi, po, pcw, pcr] = priceFor(t.model);
  return (t.input * pi + t.output * po + t.cache_write * pcw + t.cache_read * pcr) / 1e6;
}

function handleCosts(body: CostsRequest): CostsResponse {
  const { tallies, seatBySession } = readLedgerWindow(body);
  const rows: CostRow[] = [];
  // Per-wallet totals — kept separate (never one sum): subscription vs agent-sdk
  // bill different accounts. Codex "external" spend has NO ledger row (no transcript),
  // so it never appears here; `patrol status` renders it "$—", not a fabricated 0.
  const bySource: Partial<Record<BillingSource, number>> = {};
  // Fleet-level cache tax. Priced per model at that model's CACHE-WRITE rate (PRICES
  // index 2) and summed — the rates differ 5x across the table, so an average would be
  // wrong in both directions depending on the mix.
  let rebuilds = 0;
  let rebuildTokens = 0;
  let taxUsd = 0;
  for (const t of tallies.sort((a, b) => a.session_id.localeCompare(b.session_id))) {
    const cost = costOf(t);
    bySource[t.billing_source] = (bySource[t.billing_source] ?? 0) + cost;
    rows.push({
      seat_id: seatBySession.get(t.attr_session_id) ?? null,
      session_id: t.session_id,
      model: t.model,
      input: t.input,
      output: t.output,
      cache_write: t.cache_write,
      cache_read: t.cache_read,
      cost_usd: round4(cost),
      billing_source: t.billing_source,
      cache_rebuilds: t.cache_rebuilds,
      cache_rebuild_tokens: t.cache_rebuild_tokens,
    });
    rebuilds += t.cache_rebuilds;
    rebuildTokens += t.cache_rebuild_tokens;
    taxUsd += (t.cache_rebuild_tokens * priceFor(t.model)[2]) / 1e6;
  }
  // total_usd = sum of the ROUNDED buckets, so the status pool columns always add
  // up to the displayed total (no independent-rounding sub-cent gap).
  let roundedTotal = 0;
  for (const k of Object.keys(bySource) as BillingSource[]) {
    bySource[k] = round4(bySource[k]!);
    roundedTotal += bySource[k]!;
  }
  return {
    rows,
    total_usd: round4(roundedTotal),
    by_source: bySource,
    cache_tax: { rebuilds, rebuild_tokens: rebuildTokens, tax_usd: round4(taxUsd) },
  };
}

// The v0.2 evidence layer. Same window + same priced tallies as /costs, but
// aggregated per SEAT (not per session) and joined to delivery_log wake-up
// counts, seat liveness, and bound_via. Invariant vs /costs: attributed
// cost_usd + unattributed_usd == /costs total_usd for the same window, because
// both price the identical tallies from readLedgerWindow and partition them by
// the identical seatBySession map (attributed = seat_id resolved, unattributed =
// not). The only gap is 4th-decimal double-rounding (≤ $0.0001), the ledger's
// noise floor.
function handleStats(body: StatsRequest): StatsResponse {
  const { sinceIso, untilIso, tallies, seatBySession } = readLedgerWindow(body);

  // Priced ledger aggregated per resolved seat_id; spend no run claims pools
  // into unattributed. seat_id resolution is byte-identical to /costs.
  interface Agg { input: number; output: number; cache_write: number; cache_read: number; cost: number; }
  const newAgg = (): Agg => ({ input: 0, output: 0, cache_write: 0, cache_read: 0, cost: 0 });
  const bySeat = new Map<string, Agg>();
  let unattributedCost = 0;
  for (const t of tallies) {
    const cost = costOf(t);
    const seatId = seatBySession.get(t.attr_session_id) ?? null;
    if (seatId === null) {
      unattributedCost += cost;
      continue;
    }
    let a = bySeat.get(seatId);
    if (!a) { a = newAgg(); bySeat.set(seatId, a); }
    a.input += t.input;
    a.output += t.output;
    a.cache_write += t.cache_write;
    a.cache_read += t.cache_read;
    a.cost += cost;
  }

  // Every seat_run overlapping the window (bound OR not) becomes a row — an
  // unbound seat surfaces with bound_via null (the contract's "unattributed
  // seat"). Merge multiple runs of one seat_id: most-recent run wins role/model;
  // bound_via keeps the latest NON-null layer, so a later unbound re-register
  // never erases how the seat's spend was actually attributed.
  const allRuns = db.query(
    `SELECT seat_id, role, model, bound_via FROM seat_runs
     WHERE registered_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
     ORDER BY registered_at ASC`
  ).all(untilIso ?? "9999", sinceIso) as { seat_id: string; role: string | null; model: string | null; bound_via: string | null }[];
  interface Meta { role: string | null; model: string | null; bound_via: BoundVia | null; }
  const metaBySeat = new Map<string, Meta>();
  for (const r of allRuns) {
    const prev = metaBySeat.get(r.seat_id);
    metaBySeat.set(r.seat_id, {
      role: r.role,
      model: r.model,
      bound_via: (r.bound_via as BoundVia | null) ?? prev?.bound_via ?? null,
    });
  }

  // Live = a current seats-table row whose pid is alive.
  const live = new Set<string>();
  for (const s of db.query("SELECT id, pid FROM seats").all() as { id: string; pid: number }[]) {
    if (pidAlive(s.pid)) live.add(s.id);
  }

  // Wake-ups: notifications = delivery_log rows, messages = SUM(batch_size), on
  // the EXACT delivered_at (no hour bucket — delivery_log has full resolution).
  const deliv = new Map<string, { notifications: number; messages: number }>();
  const delivRows = (
    untilIso !== null
      ? db.query("SELECT to_id, COUNT(*) AS n, COALESCE(SUM(batch_size), 0) AS m FROM delivery_log WHERE delivered_at >= ? AND delivered_at <= ? GROUP BY to_id").all(sinceIso, untilIso)
      : db.query("SELECT to_id, COUNT(*) AS n, COALESCE(SUM(batch_size), 0) AS m FROM delivery_log WHERE delivered_at >= ? GROUP BY to_id").all(sinceIso)
  ) as { to_id: string; n: number; m: number }[];
  for (const d of delivRows) deliv.set(d.to_id, { notifications: d.n, messages: d.m });

  const seats: SeatStats[] = [];
  let totNotifications = 0;
  let totMessages = 0;
  let attributedCost = 0;
  for (const [seatId, meta] of metaBySeat) {
    const a = bySeat.get(seatId);
    const d = deliv.get(seatId);
    const notifications = d?.notifications ?? 0;
    const messages = d?.messages ?? 0;
    totNotifications += notifications;
    totMessages += messages;
    if (a) attributedCost += a.cost;
    seats.push({
      seat_id: seatId,
      role: meta.role,
      model: meta.model,
      live: live.has(seatId),
      bound_via: meta.bound_via,
      notifications,
      messages,
      input: a?.input ?? 0,
      output: a?.output ?? 0,
      cache_write: a?.cache_write ?? 0,
      cache_read: a?.cache_read ?? 0,
      cost_usd: round4(a?.cost ?? 0),
    });
  }
  seats.sort((x, y) => x.seat_id.localeCompare(y.seat_id));

  return {
    seats,
    totals: {
      notifications: totNotifications,
      messages: totMessages,
      cost_usd: round4(attributedCost),
      unattributed_usd: round4(unattributedCost),
    },
  };
}

// Message history for the `patrol watch` TUI. Reads the whole messages table
// (delivered rows are retained 7 days), newest cursor via MAX(id). Sender +
// recipient role/model resolve from seat_runs so dead seats still render.
function handleLog(body: LogRequest): LogResponse {
  const after = body.after_id ?? 0;
  const limit = Math.min(body.limit ?? 200, 500);
  const rows = selectLog.all(after, limit) as (Omit<LogMessage, "delivered"> & { delivered: number })[];
  const messages: LogMessage[] = rows.map((m) => ({ ...m, delivered: !!m.delivered }));
  const latestId = (selectMaxMsgId.get() as { mx: number | null }).mx ?? 0;
  return { messages, latest_id: latestId };
}

// --- v0.2.5 question inbox ---

// A seat raises a question for the human. The asker must be a LIVE seat (mirrors
// send-message's from_id guard and set-state's liveSeat check) — an answer to a
// nonexistent seat has nowhere to go. from_handle is snapshotted from the seat row
// so the inbox shows a readable name even after the seat dies.
function handleAsk(body: AskRequest): AskResponse | { ok: false; error: string } {
  const seat = db.query("SELECT pid, handle FROM seats WHERE id = ?").get(body.id) as { pid: number; handle: string | null } | null;
  if (!seat || !pidAlive(seat.pid)) return { ok: false, error: `${body.id} is not a live seat` };
  const res = insertQuestion.run(body.id, seat.handle ?? null, body.text, new Date().toISOString());
  return { ok: true, question_id: Number(res.lastInsertRowid) };
}

function handleQuestions(body: QuestionsRequest): Question[] {
  const openOnly = body.open_only ?? true; // default true — only unanswered
  const rows = (openOnly ? selectOpenQuestions.all() : selectAllQuestions.all()) as (Omit<Question, "answered"> & {
    answered: number;
  })[];
  return rows.map((r) => ({ ...r, answered: !!r.answered }));
}

// The human answers. Check-then-write (read the question, mark it, enqueue the reply),
// so it runs inside ONE db.transaction — same idiom as claimBatch/claimPathsTxn. The
// answer is delivered by inserting it through the SAME message-insert path a normal
// /send-message uses, from the reserved sender id "human" (not a seat slug, like "cli"):
// so /poll-messages leases and delivers it exactly like any inter-seat message.
// Compared by identity at the route below, so the 409 mapping can't drift from the wording.
const ASKER_GONE = "asking seat is no longer live";
const answerTxn = db.transaction((questionId: number, text: string, now: string): { ok: true } | { ok: false; error: string } => {
  const q = selectQuestionById.get(questionId) as { id: number; from_id: string; answered: number } | null;
  if (!q) return { ok: false, error: `question ${questionId} not found` };
  // Idempotent: first answer wins. A double-answer (retry, double-click) is a no-op —
  // it must NOT enqueue a second reply to the seat.
  if (q.answered) return { ok: true };
  // The asking seat must still be LIVE. If it died after asking (its row/question
  // linger until the stale sweep reaps them), marking answered + queuing a reply is a
  // lie: endSeat's undelivered-mail purge deletes that reply on the next sweep, so the
  // dashboard shows "answered" while the seat never receives it. Leave the question
  // OPEN so a live re-ask can still resolve it. Mirrors handleAsk's from_id liveness guard.
  const seat = db.query("SELECT pid FROM seats WHERE id = ?").get(q.from_id) as { pid: number } | null;
  if (!seat || !pidAlive(seat.pid)) return { ok: false, error: ASKER_GONE };
  markAnswered.run(text, now, questionId);
  insertMessage.run("human", q.from_id, text, now);
  return { ok: true };
});

// The dead-asker refusal must be a NON-2xx: a `{ok:false}` under 200 is indistinguishable
// from success to any client that checks `res.ok` (the dashboard cleared the input and
// showed the question as handled). 409 Conflict — the request is well-formed, but the
// question cannot be answered because the asker is gone; it stays OPEN. The status is
// carried out-of-band so the response BODY shape is unchanged. Other {ok:false} results
// (unknown question id) keep their 200: only the liveness refusal is being fixed here.
function handleAnswer(body: AnswerRequest): { body: { ok: true } | { ok: false; error: string }; status: number } {
  const res = answerTxn(body.question_id, body.text, new Date().toISOString());
  return { body: res, status: !res.ok && res.error === ASKER_GONE ? 409 : 200 };
}

// --- v0.2.6 worktree association ---
// git owns the tree; the broker only records the seat→worktree association so
// status/dashboard can show "seat → branch". Owner-scoped by body.id — the same
// trust model as claims/questions (the v0.3 capability-token gate covers spoofing
// later; the existing pattern is not re-invented here). The recorder must be a LIVE
// seat (mirrors handleAsk/handleClaimPath): a row owned by a ghost is exactly what
// endSeat's reap prevents, so refuse to create one.
//
// v0.2.7.1: a PATH may be associated with at most ONE seat. The table's PK is
// (seat_id, path), so the schema alone would happily let seat B claim a path seat A
// owns — two seats then share one git tree and either `patrol checkpoint` can remove
// it out from under the other. Enforced HERE rather than by a UNIQUE INDEX on path:
// a db written by v0.2.6/v0.2.7 may ALREADY hold such duplicate rows, and
// `CREATE UNIQUE INDEX IF NOT EXISTS` fails hard on existing duplicates — that would
// brick the broker at startup for exactly the users hit by the bug. Migrations here
// are additive-only, so the invariant is upheld on write and pre-existing duplicates
// are left readable (visible in /worktree-list) for the operator to resolve.
// Check-then-write runs inside ONE db.transaction (same idiom as claimBatch/answerTxn):
// no await between reading the owner and writing the row.
//
// v0.2.9: `path` arrives CANONICAL (see canonicalPath) — the comparison below is raw TEXT,
// so without that every alternate spelling of one tree read as a different path and the
// ownership check waved it through.
type Owner = { seat_id: string; handle: string | null };
const nameOwner = (o: Owner) => (o.handle ? `${o.handle} (${o.seat_id})` : o.seat_id);

const worktreeAddTxn = db.transaction(
  (id: string, path: string, branch: string, baseCommit: string, now: string): { ok: true } | { ok: false; error: string } => {
    const owners = selectWorktreeOwnersByPath.all(path) as Owner[];
    // Legacy duplicates (rows written before canonicalization, under one spelling) can put
    // TWO seats on one tree. Report every holder rather than the first — a rejection naming
    // one owner while a second lurks is how the operator "fixes" it and hits it again.
    const foreign = owners.filter((o) => o.seat_id !== id);
    if (foreign.length > 0) {
      return { ok: false, error: `${path} is already owned by ${foreign.map(nameOwner).join(", ")}` };
    }
    upsertWorktree.run(id, path, branch, baseCommit, now); // same seat re-adding: idempotent upsert
    return { ok: true };
  }
);

function handleWorktreeAdd(body: WorktreeAddRequest): { ok: true } | { ok: false; error: string } {
  if (!liveSeat(body.id)) return { ok: false, error: `${body.id} is not a live seat` };
  let path: string;
  try {
    path = canonicalPath(body.path);
  } catch {
    return { ok: false, error: `${body.path} is not an existing absolute path — record the association after the worktree exists` };
  }
  return worktreeAddTxn(body.id, path, body.branch, body.base_commit, new Date().toISOString());
}

// id given => that seat's worktrees; omitted => all seats' (raw array, like
// /list-claims — the caller coordinates).
function handleWorktreeList(body: WorktreeListRequest): Worktree[] {
  return (body.id ? selectWorktreesBySeat.all(body.id) : selectAllWorktrees.all()) as Worktree[];
}

// Drop ONE association, owner-scoped by seat_id+path (a seat can only de-register its
// OWN worktree). Idempotent: removing one that isn't there matches nothing. NEVER
// touches the git tree — the CLI removes the tree after a clean merge; this only
// forgets the association.
// v0.2.9: rows are stored canonical, but this runs AFTER `git worktree remove` — realpath
// can no longer resolve a tree that is gone, so canonicalPathOrRaw falls back to the raw
// string and the delete matches EITHER spelling. Requiring existence here would strand the
// association permanently on the one path that matters.
function handleWorktreeRemove(body: WorktreeRemoveRequest): { ok: true } {
  deleteWorktree.run(body.id, body.path);
  const canonical = canonicalPathOrRaw(body.path);
  if (canonical !== body.path) deleteWorktree.run(body.id, canonical);
  return { ok: true };
}

// --- v0.2.9 checkpoint lease ---
// The point of the whole feature: `patrol checkpoint` cannot win a race against a standing
// writer by DETECTING drift (three rounds of fences each lost it), so it takes a lease that
// QUIESCES the seat first. The seat's PreToolUse guard hook denies its mutating tools while
// the lease FILE exists; these routes are the broker's record of who holds what, which is
// what makes a stuck lease visible and sweepable.
//
// Check-then-write in ONE db.transaction and a SYNCHRONOUS handler (same idiom as
// claimBatch/worktreeAddTxn): two checkpoints racing the same tree must never both read
// "unheld" before either writes, or both would merge against a seat that only one of them
// quiesced — the exact failure this replaces.
// v0.2.9.1: ownership is the TOKEN, not the seat. `reqToken` null means "fresh acquire" —
// any unexpired lease refuses it, INCLUDING one held by the same seat, because a second
// checkpoint of one seat is a second holder, not a renewal. A non-null reqToken is a RENEW
// and must match the stored token exactly; a renewal that no longer matches means our
// lease was reaped or taken over, and the caller must abort rather than keep merging.
const leaseWorktreeTxn = db.transaction(
  (id: string, path: string, now: string, expiresAt: string, reqToken: string | null, newToken: string): LeaseWorktreeResponse => {
    const held = selectLeaseByPath.get(path) as
      | { seat_id: string; expires_at: string; token: string | null; handle: string | null }
      | null;
    // An EXPIRED lease blocks nobody: a checkpoint killed between acquire and release must
    // not wedge the tree forever, and the guard hook already fails open past expiry.
    const live = held !== null && held.expires_at > now;
    if (reqToken === null) {
      if (live) {
        const who = held!.handle ? `${held!.handle} (${held!.seat_id})` : held!.seat_id;
        return { ok: false, error: `${path} is leased until ${held!.expires_at} by ${who}` };
      }
      upsertLease.run(id, path, expiresAt, now, newToken);
      return { ok: true, expires_at: expiresAt, token: newToken };
    }
    // RENEW. Refuse on anything other than a live lease still carrying our exact token —
    // an expired one has already let the seat resume writing, so silently re-taking it
    // would hand the caller a "renewed" lease across a window it never actually held.
    if (!live || held!.token !== reqToken) {
      return { ok: false, error: `the lease on ${path} is no longer ours (expired, released, or taken over)` };
    }
    upsertLease.run(id, path, expiresAt, now, reqToken);
    return { ok: true, expires_at: expiresAt, token: reqToken };
  }
);

// "cpl-" + 32 lowercase hex. Verified against the frozen LEASE_TOKEN_RE before it leaves
// the broker, so a drift can never ship a token the clients won't match (same discipline
// as genSeatToken/SEAT_TOKEN_RE in up.ts).
function genLeaseToken(): string {
  const token = "cpl-" + randomBytes(16).toString("hex");
  if (!LEASE_TOKEN_RE.test(token)) throw new Error(`bug: generated malformed lease token "${token}"`);
  return token;
}

function handleLeaseWorktree(body: LeaseWorktreeRequest): LeaseWorktreeResponse {
  if (!liveSeat(body.id)) return { ok: false, error: `${body.id} is not a live seat` };
  let path: string;
  try {
    path = canonicalPath(body.path);
  } catch {
    return { ok: false, error: `${body.path} is not an existing absolute path` };
  }
  // A malformed token is never treated as "no token" — that would silently downgrade a
  // renewal into a fresh acquire and hand out a lease the caller's own file doesn't match.
  const reqToken = body.token ?? null;
  if (reqToken !== null && !LEASE_TOKEN_RE.test(reqToken)) {
    return { ok: false, error: `malformed lease token` };
  }
  const now = Date.now();
  return leaseWorktreeTxn(
    body.id, path,
    new Date(now).toISOString(),
    new Date(now + LEASE_TTL_SECONDS * 1000).toISOString(),
    reqToken, genLeaseToken()
  );
}

// Owner-scoped by TOKEN+path and idempotent (releasing a lease nobody holds matches
// nothing), because checkpoint releases from a `finally` on every exit path.
//
// v0.2.9.1: scoping by seat_id was the release half of the same-seat double-checkpoint
// hole — the second run's release deleted the first run's row while it was still merging.
// A token that doesn't match the stored one deletes NOTHING, so a stale or hostile release
// is a no-op rather than an un-quiesced seat.
function handleReleaseWorktree(body: ReleaseWorktreeRequest): { ok: true } {
  deleteLease.run(body.token, body.path, canonicalPathOrRaw(body.path));
  return { ok: true };
}

// --- v0.2.6 per-seat working diff (read-only, byte-bounded) -----------------
// Local shape — the orchestrator owns shared/types.ts and froze no contract for
// this, so it stays broker-local. Documented here so a later frozen type can adopt
// it verbatim:  POST /diff  { id: SeatId }  ->  { diff: string; truncated: boolean }
interface DiffRequest { id: string }
interface DiffResponse { diff: string; truncated: boolean }

// Hard cap on captured diff bytes: a runaway diff (a vendored dir, a generated lock
// file) must never let the broker buffer unbounded memory, so reading STOPS at the cap
// and flags it — never read-all-then-slice.
const DIFF_BYTE_CAP = 256 * 1024;

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return buf;
}

// Stream one `git -C <dir> <args>` process's stdout into `chunks`, appending at most
// `DIFF_BYTE_CAP - startTotal` more bytes (so callers can share one running byte budget
// across several git invocations). Once the cap is hit git is killed so a runaway file
// can't keep it filling a pipe nobody drains — a non-zero exit AFTER that is expected.
// `const proc` (not a pre-declared wide binding) so `stdout: "pipe"` narrows proc.stdout
// to a ReadableStream — same idiom as seat-server's getGitRoot. A spawn failure (no git
// on PATH) throws to gitDiff's outer try, which returns empty.
async function readGit(
  dir: string, args: string[], chunks: Uint8Array[], startTotal: number
): Promise<{ added: number; capped: boolean; code: number }> {
  const proc = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
  const reader = proc.stdout.getReader();
  let added = 0;
  let capped = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      // '>' (not '>=') so a diff exactly filling the cap isn't flagged capped until a
      // later read proves more bytes exist.
      const room = DIFF_BYTE_CAP - (startTotal + added);
      if (value.byteLength > room) {
        if (room > 0) { chunks.push(value.subarray(0, room)); added += room; }
        capped = true;
        break;
      }
      chunks.push(value);
      added += value.byteLength;
    }
  } finally {
    try { await reader.cancel(); } catch {}
    proc.kill();
  }
  const code = await proc.exited;
  return { added, capped, code };
}

// The seat's working diff: tracked changes vs HEAD PLUS untracked (new) files, captured
// under a single shared DIFF_BYTE_CAP. Without the untracked pass a seat that only created
// new files shows "no changes". Not a git repo / no HEAD / missing dir => empty string,
// never an error (a non-zero exit with nothing captured).
async function gitDiff(dir: string): Promise<DiffResponse> {
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;

    // 1) Tracked changes (staged + unstaged vs HEAD).
    const tracked = await readGit(dir, ["diff", "HEAD"], chunks, total);
    total += tracked.added;
    if (tracked.capped) truncated = true;
    // Non-repo / no HEAD exits non-zero having captured nothing => empty, never an error
    // (the pre-0.2.7 contract). A truncated diff also exits non-zero — but AFTER we killed
    // git with bytes captured — so guard on "captured nothing AND not truncated".
    if (!truncated && tracked.code !== 0 && total === 0) return { diff: "", truncated: false };

    // 2) Untracked files (respecting .gitignore). Only when the repo is healthy (tracked
    // diff exited 0) and the budget isn't already spent. Each file's content is appended
    // as a `--no-index` diff against /dev/null, sharing the SAME running byte total so
    // tracked+untracked together never exceed the cap.
    if (!truncated && tracked.code === 0) {
      const listChunks: Uint8Array[] = [];
      const list = await readGit(dir, ["ls-files", "--others", "--exclude-standard", "-z"], listChunks, 0);
      if (list.capped) truncated = true; // more untracked paths than the cap can even list
      if (list.code === 0 && list.added > 0) {
        const files = new TextDecoder().decode(concatChunks(listChunks, list.added)).split("\0").filter((f) => f.length > 0);
        for (const f of files) {
          if (truncated) break;
          // `git diff --no-index -- /dev/null <file>` exits 1 whenever the two differ —
          // ALWAYS here (/dev/null vs a real file) — which is the normal "there is a diff"
          // signal, not an error, so its exit code is deliberately ignored.
          const u = await readGit(dir, ["diff", "--no-index", "--", "/dev/null", f], chunks, total);
          total += u.added;
          if (u.capped) truncated = true;
        }
      }
    }

    return { diff: new TextDecoder().decode(concatChunks(chunks, total)), truncated };
  } catch {
    return { diff: "", truncated: false };
  }
}

// Owner-agnostic read (the token gate already applies): resolve the seat's dir — its
// most-recent tracked task worktree if any, else its registered cwd — and diff it. An
// unknown/reaped seat has no dir => empty diff, not an error (matches "no diff").
async function handleDiff(body: DiffRequest): Promise<DiffResponse> {
  const seat = db.query("SELECT cwd FROM seats WHERE id = ?").get(body.id) as { cwd: string } | null;
  if (!seat) return { diff: "", truncated: false };
  const worktrees = selectWorktreesBySeat.all(body.id) as Worktree[]; // ORDER BY created_at asc
  const dir = worktrees.length ? worktrees[worktrees.length - 1]!.path : seat.cwd;
  return gitDiff(dir);
}

// --- v0.2.6 budget alerts (OBSERVE-ONLY) ---
// Crossing a per-seat cap pings the alert recipient ONCE — it never gates or stops
// the model (the frozen contract's semantics: Patrol observes spend, it does not
// enforce it). Fired at the tail of each index tick, AFTER the ledger is refreshed,
// so an alert can never precede the spend that triggered it. The budget_alerted latch
// (a seats column, reaped with the row in endSeat) is what makes it fire once, not
// every tick.

// Flag + enqueue as ONE check-then-write (same idiom as answerTxn): a crash between
// them must not drop the alert or leave it re-firing. The alert goes through the SAME
// insertMessage path a /send-message uses, from the reserved sender "patrol" (not a
// seat slug — like "human"/"cli"), so /poll-messages leases and delivers it like any
// inter-seat message.
const alertTxn = db.transaction((seatId: string, recipientId: string, text: string, now: string) => {
  db.run("UPDATE seats SET budget_alerted = 1 WHERE id = ?", [seatId]);
  insertMessage.run("patrol", recipientId, text, now);
});

// Resolve who hears a budget crossing. `target` is the seat's stored budget_alert_to
// (v0.2.7 RegisterRequest.budget_alert_to, from fleet PatrolConfig): a configured
// handle (matched first) or role wins over the default. When it's null or resolves to
// no live seat, fall back to the contract DEFAULT recipient — the live seat whose role
// is "orchestrator". Returns a live seat id, or null when nothing resolves (caller
// no-ops + logs, and MUST NOT latch — a later tick retries once a recipient is live).
function resolveAlertRecipient(target: string | null): string | null {
  const live = (
    db.query("SELECT id, pid, handle, role FROM seats").all() as {
      id: string; pid: number; handle: string | null; role: string | null;
    }[]
  ).filter((s) => pidAlive(s.pid));
  if (target) {
    const byHandle = live.find((s) => s.handle === target);
    if (byHandle) return byHandle.id;
    const byRole = live.find((s) => s.role === target);
    if (byRole) return byRole.id;
  }
  const orch = live.find((s) => s.role === "orchestrator");
  return orch ? orch.id : null;
}

// Per-seat cumulative-spend check. Only seats WITH a cap and NOT yet alerted are
// considered. Spend is summed by the SAME aggregation /costs and /stats use
// (readLedgerWindow + costOf), over the SAME default window (since broker start), so
// the alert can never fire on a number `patrol status` doesn't show. A missing
// recipient no-ops with ONE log line but does NOT latch — the alert is retried on a
// later tick once a recipient is live (latching there would drop it forever). Only
// alertTxn, which actually queues the message, latches budget_alerted. A budget cap
// must NEVER throw inside the index tick and starve indexing.
function checkBudgets() {
  const capped = db.query(
    "SELECT id, handle, role, budget_usd, budget_alert_to FROM seats WHERE budget_usd IS NOT NULL AND budget_alerted = 0"
  ).all() as { id: string; handle: string | null; role: string | null; budget_usd: number; budget_alert_to: string | null }[];
  if (capped.length === 0) return;

  const { tallies, seatBySession } = readLedgerWindow({});
  const spendBySeat = new Map<string, number>();
  for (const t of tallies) {
    const seatId = seatBySession.get(t.attr_session_id);
    if (!seatId) continue;
    spendBySeat.set(seatId, (spendBySeat.get(seatId) ?? 0) + costOf(t));
  }

  const now = new Date().toISOString();
  for (const seat of capped) {
    const spend = spendBySeat.get(seat.id) ?? 0;
    if (spend < seat.budget_usd) continue;
    const handle = seat.handle ?? seat.id;
    const text = `⚠ ${handle} crossed its $${seat.budget_usd} budget — now $${spend.toFixed(2)}`;
    const recipient = resolveAlertRecipient(seat.budget_alert_to); // configured handle/role wins; else orchestrator default
    if (!recipient) {
      // Do NOT latch: a crossing with no live recipient is retried next tick (once an
      // orchestrator/configured seat is live it alerts) instead of being dropped forever.
      log(`budget: ${handle} crossed $${seat.budget_usd} (now $${spend.toFixed(2)}) but no live alert recipient — will retry`);
      continue;
    }
    alertTxn(seat.id, recipient, text, now);
    log(`budget: ${handle} crossed $${seat.budget_usd} (now $${spend.toFixed(2)}) — alerted ${recipient}`);
  }
}

// --- Background cost indexer (keeps /costs off the fs) ---

function hourBucket(tsMs: number | null): number {
  if (tsMs === null || Number.isNaN(tsMs)) return 0;
  return Math.floor(tsMs / HOUR_MS) * HOUR_MS;
}

// Project dirs worth scanning: live seats' dirs + any dir we've already indexed
// (persisted across restarts). Non-fleet projects are never read, so the ledger
// — and /costs — stays scoped to the fleet without a project filter downstream.
function interestedProjects(): Set<string> {
  const s = new Set<string>();
  for (const row of db.query("SELECT DISTINCT cwd FROM seats").all() as { cwd: string }[]) {
    s.add(projectDirName(row.cwd));
  }
  const prefix = ROOT.endsWith("/") ? ROOT : ROOT + "/";
  for (const row of db.query("SELECT file_path FROM session_index").all() as { file_path: string }[]) {
    if (row.file_path.startsWith(prefix)) {
      const seg = row.file_path.slice(prefix.length).split("/")[0];
      if (seg) s.add(seg);
    }
  }
  return s;
}

// Hash of the last <=ANCHOR_BYTES bytes before `cursor`, or null if the file
// can't be read. Stored on every index write and re-checked next tick: a plain
// append only adds bytes AFTER the cursor, so this range — and its hash — stay
// intact; an in-place rewrite (session resume) changes bytes before the cursor,
// so the hash diverges. Empty prefix (cursor<=0) is the stable "0" sentinel.
const ANCHOR_BYTES = 256;
function anchorHash(file: string, cursor: number): string | null {
  if (cursor <= 0) return "0";
  const start = Math.max(0, cursor - ANCHOR_BYTES);
  const len = cursor - start;
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return String(Bun.hash(buf.subarray(0, read)));
  } finally {
    closeSync(fd);
  }
}

// Parse the stored session_ids column (JSON array) defensively: a legacy NULL
// (row written before the column existed) or any malformed value degrades to an
// empty list rather than throwing on the index path.
function parseSessionIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Same defensive shape for the per-session running cache_read max. A legacy NULL or a
// malformed value degrades to "no prefix established yet", which can only UNDER-count
// rebuilds — the safe direction for a number we publish.
function parseMaxCacheRead(raw: string | null): Map<string, number> {
  const m = new Map<string, number>();
  if (!raw) return m;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o)) if (typeof v === "number" && Number.isFinite(v)) m.set(k, v);
    }
  } catch {
    // malformed -> empty
  }
  return m;
}

// Index one file: skip if (size,mtime) unchanged; resume from the saved cursor;
// full reparse when the file shrank (size < cursor) OR was rewritten in place
// (changed without shrinking AND the anchor bytes no longer match). A plain
// append tail-parses from the cursor. seen_msgs keeps accounting idempotent
// regardless of the cursor.
function indexFile(file: string, parentSessionId: string | null) {
  let st: { size: number; mtimeMs: number };
  try {
    st = statSync(file);
  } catch {
    return;
  }
  const size = st.size;
  const mtime = Math.floor(st.mtimeMs);
  const prev = idxGet.get(file) as { bytes_parsed: number; mtime_ms: number; anchor_hash: string | null; session_ids: string | null; max_cache_read: string | null } | null;
  let fromByte = prev?.bytes_parsed ?? 0;
  let reset = false;
  // A row written before the session_ids column existed (additive migration) has
  // it NULL. Such a row can't answer "what did this file contribute?" at reset
  // time, so a pre-upgrade transcript rewritten before any post-upgrade append
  // would strand its old ledger rows (round-3 finding). One-time self-heal: force
  // a full reparse of every legacy row — bypassing the unchanged early-return —
  // so session_ids gets recorded AND reconciled against current content before any
  // rewrite can slip past. After this pass session_ids is non-null, so the row is
  // never legacy again. (session_ids NULL also implies the earlier anchor_hash was
  // NULL or predates it, so keying on session_ids covers every legacy row.)
  const isLegacy = prev != null && prev.session_ids == null;
  if (prev) {
    if (!isLegacy && size === prev.bytes_parsed && mtime === prev.mtime_ms) return; // unchanged (already backfilled)
    if (isLegacy || size < prev.bytes_parsed) {
      fromByte = 0;
      reset = true;
    } else if (mtime !== prev.mtime_ms && prev.anchor_hash != null && anchorHash(file, prev.bytes_parsed) !== prev.anchor_hash) {
      // Changed without shrinking, and the bytes before the old cursor moved:
      // an in-place rewrite (not a pure append). Reparse from 0 so a same-size
      // rewrite or a rewrite-then-grow can't leave stale totals in the ledger.
      fromByte = 0;
      reset = true;
    }
  }
  const { records, bytesParsed } = parseFileTail(file, fromByte);
  const anchor = anchorHash(file, bytesParsed);

  const newIds = new Set(records.map((r) => r.sessionId));
  const priorIds = parseSessionIds(prev?.session_ids ?? null);
  // Legacy self-heal, best-effort prior-id recovery when current content can no
  // longer supply it (the file was already rewritten/emptied pre-upgrade): a flat
  // top-level file's contributed session id IS its filename stem (sessionFiles
  // yields parent=null for these), so seed it into priorIds to delete the stale
  // rows below even if the content is now gone. A subagents/ file's own session id
  // is not in its filename and is unrecoverable once its content is gone — that
  // residual sliver is a known limit: its stale rows persist until the file next
  // changes with content.
  if (isLegacy && parentSessionId == null) {
    priorIds.push(basename(file).replace(/\.jsonl$/, ""));
  }
  // A reset re-adds only the current content, so its recorded contribution IS the
  // new ids; a plain append accumulates (prior ∪ new) so a session an append tick
  // happens not to re-mention isn't dropped from the file's recorded contribution.
  const storedIds = reset ? newIds : new Set([...priorIds, ...newIds]);

  db.transaction(() => {
    if (reset) {
      // The file shrank/was rewritten: drop its PRIOR contribution (the stored
      // ids) as well as any current-content ids, then re-add the full current
      // content below. Deleting by the stored ids — not just the newly parsed
      // ones — is what clears a rewrite-to-empty or a changed-session_id file
      // whose old rows would otherwise linger and double-count.
      for (const sid of new Set([...priorIds, ...newIds])) {
        db.run("DELETE FROM cost_ledger WHERE session_id = ?", [sid]);
        db.run("DELETE FROM seen_msgs WHERE session_id = ?", [sid]);
      }
    }
    // Per-session billing_source for THIS batch: any sdk* record makes the whole
    // session agent-sdk (a session has one launch lineage; entrypoint can be absent
    // on some records). Combined with the ledger's upgrade-only ON CONFLICT, a later
    // sdk line fixes an earlier subscription row across ticks too.
    const sessionSrc = new Map<string, BillingSource>();
    for (const r of records) {
      if (billingSourceFromEntrypoint(r.entrypoint) === "agent-sdk") sessionSrc.set(r.sessionId, "agent-sdk");
    }
    // aggregate this batch's deltas, deduping resume-rewrites via seen_msgs
    const agg = new Map<string, { sid: string; attr: string; model: string; bucket: number; i: number; o: number; cw: number; cr: number; rb: number; rbt: number }>();
    // Carried across ticks so a session's prefix history isn't forgotten between them; a
    // reset starts clean because the file is being reparsed from byte 0.
    const maxCacheRead = reset ? new Map<string, number>() : parseMaxCacheRead(prev?.max_cache_read ?? null);
    for (const r of records) {
      if (r.msgId) {
        if (seenGet.get(r.sessionId, r.msgId)) continue; // already counted
        seenIns.run(r.sessionId, r.msgId);
      }
      const attr = parentSessionId ?? r.sessionId;
      const bucket = hourBucket(r.tsMs);
      const key = `${r.sessionId}\0${r.model}\0${bucket}`;
      let a = agg.get(key);
      if (!a) {
        a = { sid: r.sessionId, attr, model: r.model, bucket, i: 0, o: 0, cw: 0, cr: 0, rb: 0, rbt: 0 };
        agg.set(key, a);
      }
      a.i += r.input;
      a.o += r.output;
      a.cw += r.cache_write;
      a.cr += r.cache_read;
      // Records arrive in file order, which is session order — the classifier depends on
      // that, so this must stay inside the same in-order walk as the token tallies.
      const cls = classifyCacheRebuild(r.cache_write, r.cache_read, maxCacheRead.get(r.sessionId) ?? 0);
      maxCacheRead.set(r.sessionId, cls.maxCacheRead);
      if (cls.rebuild) {
        a.rb += 1;
        a.rbt += r.cache_write;
      }
    }
    for (const a of agg.values()) upsertLedger.run(a.sid, a.attr, a.model, a.bucket, a.i, a.o, a.cw, a.cr, sessionSrc.get(a.sid) ?? "subscription", a.rb, a.rbt);
    idxSet.run(file, parentSessionId, bytesParsed, mtime, anchor, JSON.stringify([...storedIds]), JSON.stringify(Object.fromEntries(maxCacheRead)));
  })();
}

// Bound the token re-scan (perf). A run whose launch marker never lands (a
// silent seat, or a marker that never reached the log) would otherwise re-scan
// its whole project dir on every tick forever. Two bounds: (1) a per-run cache of
// unchanged non-matching files so only new/changed files are re-read, and (2) a
// cap on unsuccessful scans, after which the TOKEN scan is abandoned. Only the
// marker scan gives up — Layer-2 observe (reg-session SessionStart) can still bind
// the run later. ~40 ticks ≈ 8 min at the production cadence; env-overridable.
const TOKEN_SCAN_CAP = parseInt(process.env.CLAUDE_PATROL_TOKEN_SCAN_CAP ?? "40", 10);
interface RunScan {
  misses: Map<string, { size: number; mtimeMs: number }>; // files read and found NOT to contain the token
  attempts: number; // count of scans that found no match (the abandonment counter)
  abandoned: boolean;
}
const runScans = new Map<number, RunScan>(); // run_id -> scan state; pruned when a run leaves pending

// Resolve runs still missing a session_id. Launcher seats (have a token) bind
// ONLY via Layer-1 content match — never the heuristic, which can't separate
// same-cwd seats; manual seats (no token) fall to Layer-3. Cross-run uniqueness:
// never bind a session another OPEN run already owns (an ended run's session may
// be re-bound by a newer live run — see the ownedByOther note in observe).
function resolvePendingRuns() {
  const pending = db.query(
    "SELECT run_id, seat_token, cwd, registered_at FROM seat_runs WHERE session_id IS NULL AND ended_at IS NULL"
  ).all() as { run_id: number; seat_token: string | null; cwd: string; registered_at: string }[];

  // A run leaves `pending` once bound (elsewhere, e.g. observe) or ended; drop its
  // scan state so these caches can't grow unbounded over a long-lived broker.
  const pendingIds = new Set(pending.map((r) => r.run_id));
  for (const id of runScans.keys()) if (!pendingIds.has(id)) runScans.delete(id);

  for (const run of pending) {
    let sid: string | null = null;
    // The branch taken IS the attribution layer: token content-match (Layer 1)
    // vs the mtime heuristic (Layer 3).
    const via: BoundVia = run.seat_token ? "token" : "heuristic";
    if (run.seat_token) {
      let scan = runScans.get(run.run_id);
      if (!scan) {
        scan = { misses: new Map(), attempts: 0, abandoned: false };
        runScans.set(run.run_id, scan);
      }
      if (scan.abandoned) continue; // token scan given up — observe (Layer 2) can still bind this run
      sid = resolveTokenToSession({ cwd: run.cwd, projectsRoot: ROOT, token: run.seat_token }, scan.misses);
      if (!sid) {
        scan.attempts++;
        if (scan.attempts >= TOKEN_SCAN_CAP) {
          scan.abandoned = true;
          scan.misses.clear(); // won't scan again — free the cache
          log(
            `run ${run.run_id} token unresolved after ${scan.attempts} scans ` +
              `(~${Math.round((scan.attempts * INDEX_INTERVAL_MS) / 1000)}s); abandoning token scan (observe can still bind)`
          );
        }
        continue;
      }
    } else {
      sid = findSessionIdByHeuristic({ cwd: run.cwd, projectsRoot: ROOT, nowMs: Date.now() });
      if (!sid) continue;
    }
    const owner = db.query("SELECT run_id FROM seat_runs WHERE session_id = ? AND run_id != ? AND ended_at IS NULL").get(sid, run.run_id) as { run_id: number } | null;
    if (owner) {
      log(`token/heuristic resolved run ${run.run_id} to ${sid} but an open run already owns it — left unbound`);
      continue;
    }
    db.run("UPDATE seat_runs SET session_id = ?, bound_via = ? WHERE run_id = ?", [sid, via, run.run_id]);
    runScans.delete(run.run_id); // bound — drop scan state
  }
}

function indexTick() {
  try {
    // No live seat means nothing to attribute — a broker left running after
    // `patrol down` must not keep scanning 1.8 GB of session logs. Cost history
    // already on disk is unaffected; it resumes indexing when a seat registers.
    const liveSeats = (selectAllSeats.all() as { pid: number }[]).some((s) => pidAlive(s.pid));
    if (!liveSeats) return;
    for (const [file, , parent] of sessionFiles(ROOT, interestedProjects())) {
      try {
        indexFile(file, parent); // isolate: one unindexable file must not starve the rest
      } catch (e) {
        log(`index error on ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    resolvePendingRuns();
    // Budget alerts run on the freshly-updated ledger. Isolated try: a budget bug
    // (or a wedged recipient lookup) must never abort a tick whose indexing already
    // completed above — nor throw out of the cost tick.
    try {
      checkBudgets();
    } catch (e) {
      log(`budget check error: ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (e) {
    log(`index tick error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Runtime request validation (security Fix 2) ---
// `body as X` casts are compile-time fiction at a trust boundary: any local
// process with the secret can POST arbitrary JSON. Shape/size checks protect
// the DB and the cost metric (one oversized body wakes a seat at full-context
// price and bloats SQLite). Returns a terse error string, or null when valid.

const SLUG_RE = /^[a-z0-9]{8}$/;
const SEAT_STATES = new Set<string>(["idle", "working", "blocked", "done", "unknown"] satisfies SeatState[]);
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_SUMMARY = 500;
const MAX_PATH = 1024;
const MAX_LABEL = 128;
const QUEUE_DEPTH_CAP = 100;

function isStr(v: unknown, max: number, min = 0): v is string {
  return typeof v === "string" && v.length >= min && v.length <= max;
}
function isOptStr(v: unknown, max: number): boolean {
  return v == null || isStr(v, max);
}
function isPosInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 2 ** 31;
}
function isSlug(v: unknown): v is string {
  return typeof v === "string" && SLUG_RE.test(v);
}
function isOptIso(v: unknown): boolean {
  return v == null || (isStr(v, 64) && !Number.isNaN(Date.parse(v)));
}

export function validate(path: string, body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  switch (path) {
    case "/register":
      if (!isPosInt(b.pid)) return "pid must be a positive integer";
      if (!isStr(b.cwd, MAX_PATH, 1)) return "cwd must be a non-empty string";
      if (!isOptStr(b.git_root, MAX_PATH)) return "git_root too long or not a string";
      if (!isOptStr(b.tty, MAX_LABEL)) return "tty too long or not a string";
      if (!isStr(b.summary, MAX_SUMMARY)) return `summary must be a string ≤${MAX_SUMMARY} chars`;
      for (const k of ["role", "model", "profile"]) {
        if (!isOptStr(b[k], MAX_LABEL)) return `${k} too long or not a string`;
      }
      if (!isOptStr(b.session_id, 256)) return "session_id too long or not a string";
      if (b.seat_token != null && !(typeof b.seat_token === "string" && SEAT_TOKEN_RE.test(b.seat_token)))
        return "seat_token must match cp-<8hex>";
      if (b.budget_usd != null && !(typeof b.budget_usd === "number" && Number.isFinite(b.budget_usd) && b.budget_usd > 0))
        return "budget_usd must be a positive number";
      if (!isOptStr(b.budget_alert_to, MAX_LABEL)) return "budget_alert_to too long or not a string";
      if (b.guarded != null && typeof b.guarded !== "boolean") return "guarded must be a boolean";
      if (!isOptStr(b.lease_file, MAX_PATH)) return "lease_file too long or not a string";
      return null;
    case "/heartbeat":
    case "/poll-messages":
      return isSlug(b.id) ? null : "id must be an 8-char [a-z0-9] slug";
    case "/ack": {
      if (!isSlug(b.id)) return "id must be an 8-char [a-z0-9] slug";
      if (!Array.isArray(b.message_ids)) return "message_ids must be an array of message ids";
      if (!b.message_ids.every((n) => typeof n === "number" && Number.isInteger(n) && n > 0)) {
        return "message_ids must be an array of positive integer message ids";
      }
      return null;
    }
    case "/set-summary":
      if (!isSlug(b.id)) return "id must be an 8-char [a-z0-9] slug";
      return isStr(b.summary, MAX_SUMMARY) ? null : `summary must be a string ≤${MAX_SUMMARY} chars`;
    case "/rename":
      if (!isSlug(b.id)) return "id must be an 8-char [a-z0-9] slug";
      if (!isStr(b.name, MAX_LABEL, 1)) return `name must be a non-empty string ≤${MAX_LABEL} chars`;
      // MED-1: an explicit rename to an id-shaped name would shadow a real seat id
      // in resolveSeatTarget. Reject it here (auto-assignment suffixes instead).
      if (looksLikeSeatId(slug(b.name))) return "name must not look like a seat id (8 chars of a-z0-9)";
      return null;
    case "/send-message": {
      if (b.from_id !== "cli" && !isSlug(b.from_id)) return 'from_id must be a seat slug or "cli"';
      if (!isSlug(b.to_id)) return "to_id must be an 8-char [a-z0-9] slug";
      if (typeof b.text !== "string" || Buffer.byteLength(b.text, "utf8") > MAX_TEXT_BYTES)
        return `text must be a string ≤${MAX_TEXT_BYTES} bytes`;
      return null;
    }
    case "/unregister": {
      const hasId = b.id != null, hasPid = b.pid != null;
      if (hasId === hasPid) return "exactly one of id or pid required";
      if (hasId && !isSlug(b.id)) return "id must be an 8-char [a-z0-9] slug";
      if (hasPid && !isPosInt(b.pid)) return "pid must be a positive integer";
      return null;
    }
    case "/costs":
    case "/stats":
      if (!isOptIso(b.since)) return "since must be an ISO timestamp";
      if (!isOptIso(b.until)) return "until must be an ISO timestamp";
      return null;
    case "/observe-session":
      if (!isStr(b.session_id, 256, 1)) return "session_id must be a non-empty string";
      if (!isStr(b.transcript_path, MAX_PATH, 1)) return "transcript_path must be a non-empty string";
      if (!isStr(b.cwd, MAX_PATH, 1)) return "cwd must be a non-empty string";
      if (!isPosInt(b.claude_pid)) return "claude_pid must be a positive integer";
      return null;
    case "/log":
      if (b.after_id != null && !(typeof b.after_id === "number" && Number.isInteger(b.after_id) && b.after_id >= 0))
        return "after_id must be a non-negative integer";
      if (b.limit != null && !isPosInt(b.limit)) return "limit must be a positive integer";
      return null;
    case "/set-state":
      if (!isSlug(b.id)) return "id must be an 8-char [a-z0-9] slug";
      if (!SEAT_STATES.has(b.state as string)) return `state must be one of ${[...SEAT_STATES].join("|")}`;
      return null;
    case "/wait-for": {
      // The waiter id is for auth/logging only (the handler reads `target`, not `id`).
      // Allow "cli" like /send-message's from_id, so the CLI `patrol wait` can call it
      // without owning a seat; a real seat waiter passes its own slug.
      if (b.id !== "cli" && !isSlug(b.id)) return 'id must be a seat slug or "cli"';
      if (!isSlug(b.target)) return "target must be an 8-char [a-z0-9] slug";
      if (!Array.isArray(b.until) || b.until.length < 1) return "until must be a non-empty array of seat states";
      if (!b.until.every((s) => typeof s === "string" && SEAT_STATES.has(s))) return `until must contain only ${[...SEAT_STATES].join("|")}`;
      // Cap the timeout so a caller can't pin a request open forever (a resource DoS).
      if (!(typeof b.timeout_ms === "number" && Number.isFinite(b.timeout_ms) && b.timeout_ms >= 0 && b.timeout_ms <= WAITFOR_TIMEOUT_CAP_MS))
        return `timeout_ms must be a number between 0 and ${WAITFOR_TIMEOUT_CAP_MS}`;
      return null;
    }
    case "/claim-port":
      if (!isSlug(b.id)) return "id must be an 8-char [a-z0-9] slug";
      if (b.count != null && (!isPosInt(b.count) || (b.count as number) > MAX_PORT_COUNT))
        return `count must be a positive integer ≤${MAX_PORT_COUNT}`;
      return null;
    case "/claim-path": {
      if (!isSlug(b.id)) return "id must be an 8-char [a-z0-9] slug";
      if (!Array.isArray(b.paths) || b.paths.length < 1 || b.paths.length > MAX_CLAIM_PATHS)
        return `paths must be a non-empty array of ≤${MAX_CLAIM_PATHS} strings`;
      if (!b.paths.every((p) => isStr(p, MAX_PATH, 1))) return `each path must be a non-empty string ≤${MAX_PATH} chars`;
      return null;
    }
    case "/release-claims": {
      if (!isSlug(b.id)) return "id must be an 8-char [a-z0-9] slug";
      if (b.paths != null) {
        if (!Array.isArray(b.paths) || b.paths.length > MAX_CLAIM_PATHS) return `paths must be an array of ≤${MAX_CLAIM_PATHS} strings`;
        if (!b.paths.every((p) => isStr(p, MAX_PATH, 1))) return `each path must be a non-empty string ≤${MAX_PATH} chars`;
      }
      return null;
    }
    case "/list-claims":
      if (!isOptStr(b.git_root, MAX_PATH)) return "git_root too long or not a string";
      return null;
    case "/ask":
      if (!isSlug(b.id)) return "id must be an 8-char [a-z0-9] slug";
      if (typeof b.text !== "string" || b.text.length < 1 || Buffer.byteLength(b.text, "utf8") > MAX_TEXT_BYTES)
        return `text must be a non-empty string ≤${MAX_TEXT_BYTES} bytes`;
      return null;
    case "/questions":
      if (b.open_only != null && typeof b.open_only !== "boolean") return "open_only must be a boolean";
      return null;
    case "/answer":
      if (!isPosInt(b.question_id)) return "question_id must be a positive integer";
      if (typeof b.text !== "string" || b.text.length < 1 || Buffer.byteLength(b.text, "utf8") > MAX_TEXT_BYTES)
        return `text must be a non-empty string ≤${MAX_TEXT_BYTES} bytes`;
      return null;
    case "/worktree-add":
      if (!isSlug(b.id)) return "id must be an 8-char [a-z0-9] slug";
      if (!isStr(b.path, MAX_PATH, 1)) return `path must be a non-empty string ≤${MAX_PATH} chars`;
      if (!isStr(b.branch, MAX_LABEL, 1)) return `branch must be a non-empty string ≤${MAX_LABEL} chars`;
      if (!isStr(b.base_commit, MAX_LABEL, 1)) return `base_commit must be a non-empty string ≤${MAX_LABEL} chars`;
      return null;
    case "/worktree-list":
      if (b.id != null && !isSlug(b.id)) return "id must be an 8-char [a-z0-9] slug";
      return null;
    case "/worktree-remove":
    // v0.2.9: same shape as /worktree-remove — a slug id and a bounded path. Existence and
    // canonicalization are the HANDLER's job (they need the filesystem, validate() is pure).
    case "/lease-worktree":
      if (!isSlug(b.id)) return "id must be an 8-char [a-z0-9] slug";
      if (!isStr(b.path, MAX_PATH, 1)) return `path must be a non-empty string ≤${MAX_PATH} chars`;
      // v0.2.9.1: optional — absent is a fresh acquire, present is a renewal. Shape is
      // re-checked in the handler; here it only bounds what reaches the db.
      if (b.token != null && !(isStr(b.token, 36, 36) && LEASE_TOKEN_RE.test(b.token))) return "token must match cpl-<32 hex>";
      return null;
    case "/release-worktree":
      if (!isSlug(b.id)) return "id must be an 8-char [a-z0-9] slug";
      if (!isStr(b.path, MAX_PATH, 1)) return `path must be a non-empty string ≤${MAX_PATH} chars`;
      // REQUIRED here, unlike the acquire: a release is only ever a claim of ownership,
      // and one that can't present the token must delete nothing.
      if (!(isStr(b.token, 36, 36) && LEASE_TOKEN_RE.test(b.token))) return "token must match cpl-<32 hex>";
      return null;
    case "/diff":
      return isSlug(b.id) ? null : "id must be an 8-char [a-z0-9] slug";
    case "/dash-token":
      return null; // no body fields; the full-secret gate is the only guard it needs
    default:
      return null; // unknown route 404s below
  }
}

// --- HTTP server ---

const SECRET = getSecret();

// v0.2.7 scoped dashboard tokens. GET /dashboard no longer hands out the full SECRET
// (an unauthenticated GET leaking the key that authorizes /send-message et al). Instead
// `patrol dash` mints a short-lived nonce via POST /dash-token (full-secret authed); the
// page authenticates with THAT. A leaked nonce is READ-only + /answer and loopback-only,
// so it can't drive the fleet. In-memory only: nonces die with the broker (a restart just
// re-mints), and never touch disk. Pruned lazily on mint.
const DASH_TOKEN_TTL_MS = 8 * HOUR_MS; // ~8h — one working session
const dashTokens = new Map<string, number>(); // nonce -> expiry epoch ms
// Routes a dash-nonce may reach: the dashboard's read set + /answer (the human replying
// to a question inbox). ANY other route (send-message, unregister, register, claims,
// worktree, set-state, rename, ack, ...) rejects a nonce, so a leaked one can't act.
const DASH_ALLOWED = new Set(["/list-seats", "/log", "/stats", "/costs", "/questions", "/diff", "/answer"]);

function mintDashToken(): string {
  const now = Date.now();
  for (const [tok, exp] of dashTokens) if (exp <= now) dashTokens.delete(tok); // lazy prune
  const nonce = crypto.randomUUID() + crypto.randomUUID(); // unguessable, no disk
  dashTokens.set(nonce, now + DASH_TOKEN_TTL_MS);
  return nonce;
}

function dashTokenValid(tok: string | null | undefined): boolean {
  if (!tok) return false;
  const exp = dashTokens.get(tok);
  if (exp === undefined) return false;
  if (exp <= Date.now()) { dashTokens.delete(tok); return false; }
  return true;
}

// CSRF guard for browser-driven (dash-nonce) requests only: a malicious page the user
// visits must not be able to drive the broker through their browser. The dashboard's own
// fetch() carries a loopback Origin; a cross-site page carries its own. Modern browsers
// send Origin on every POST, so its ABSENCE means a non-browser/same-origin caller (the
// CLI, tests) — accepted via the always-present Host. The full-secret path never runs this.
function loopbackHostname(h: string | null): boolean {
  if (!h) return false;
  const host = h.replace(/:\d+$/, ""); // strip :port (not present on bracketed [::1]:port either way)
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}
function csrfOk(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    try { return loopbackHostname(new URL(origin).hostname); } catch { return false; }
  }
  return loopbackHostname(req.headers.get("host"));
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  // Reject oversized POSTs before req.json() ever buffers them.
  maxRequestBodySize: 64 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", seats: (selectAllSeats.all() as Seat[]).length });
      }
      if (path === "/dashboard") {
        // v0.2.7: nonce-gated (no longer open like /health). The page is served ONLY to a
        // caller holding a valid dash nonce (?t=…), minted by `patrol dash` via the full
        // secret. A missing/expired/unknown nonce gets 401 with no HTML and no secret — so
        // an unauthenticated GET can't leak the key. The page's POSTs authenticate with the
        // NONCE (injected below), not the secret, which the scope gate limits to read+answer.
        const t = url.searchParams.get("t");
        if (!dashTokenValid(t)) {
          return new Response("unauthorized", { status: 401 });
        }
        try {
          const raw = await Bun.file(new URL("./dashboard/index.html", import.meta.url)).text();
          // Inject the NONCE (not SECRET). JSON.stringify keeps the value safe to embed.
          const html = raw.replaceAll('"__PATROL_TOKEN__"', JSON.stringify(t));
          return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
        } catch (e) {
          return new Response(`dashboard unavailable: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
        }
      }
      return new Response("claude-patrol broker", { status: 200 });
    }

    // Resolve the presented token to a scope ONCE. `full` = the real secret (CLI, full
    // access, unchanged). `dash` = a live dashboard nonce (read set + /answer only, and
    // loopback-only). `none` = neither -> 401.
    const presented = req.headers.get(TOKEN_HEADER);
    const scope: "full" | "dash" | "none" =
      presented === SECRET ? "full" : dashTokenValid(presented) ? "dash" : "none";
    if (scope === "none") {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (scope === "dash") {
      // A nonce is accepted ONLY on the read set + /answer, and only from a loopback origin.
      if (!DASH_ALLOWED.has(path)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (!csrfOk(req)) {
        return Response.json({ error: "cross-origin request refused" }, { status: 401 });
      }
    }

    try {
      const body = await req.json();
      const invalid = validate(path, body);
      if (invalid) return Response.json({ error: invalid }, { status: 400 });
      switch (path) {
        case "/dash-token":
          // Mint a scoped dashboard nonce. Reachable only at scope `full` — a dash nonce
          // can't reach here (not in DASH_ALLOWED), so it can't mint another nonce.
          return Response.json({ token: mintDashToken() });
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          updateLastSeen.run(new Date().toISOString(), (body as HeartbeatRequest).id);
          return Response.json({ ok: true });
        case "/set-summary":
          updateSummary.run((body as SetSummaryRequest).summary, (body as SetSummaryRequest).id);
          return Response.json({ ok: true });
        case "/list-seats":
          return Response.json(handleListSeats(body as ListSeatsRequest));
        case "/send-message": {
          const b = body as SendMessageRequest;
          // Queue-depth cap: an unread backlog this deep means the receiver is
          // gone or the sender is looping; more rows only bloat SQLite and the
          // eventual context bill.
          const depth = (
            db.query("SELECT COUNT(*) AS c FROM messages WHERE to_id = ? AND delivered = 0").get(b.to_id) as { c: number }
          ).c;
          if (depth >= QUEUE_DEPTH_CAP) {
            return Response.json(
              { ok: false, error: `queue for ${b.to_id} is full (${depth} undelivered)` },
              { status: 429 }
            );
          }
          return Response.json(handleSendMessage(b));
        }
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/ack":
          return Response.json(handleAck(body as AckRequest));
        case "/costs":
          return Response.json(handleCosts(body as CostsRequest));
        case "/stats":
          return Response.json(handleStats(body as StatsRequest));
        case "/observe-session":
          return Response.json(handleObserveSession(body as ObserveSessionRequest));
        case "/log":
          return Response.json(handleLog(body as LogRequest));
        case "/unregister":
          handleUnregister(body as UnregisterRequest);
          return Response.json({ ok: true });
        case "/set-state":
          return Response.json(handleSetState(body as SetStateRequest));
        case "/wait-for":
          // Long-poll: the await yields the Bun thread between reads, so a wedged
          // wait never starves a concurrent /list-seats.
          return Response.json(await handleWaitFor(body as WaitForRequest));
        case "/rename":
          return Response.json(handleRename(body as RenameRequest));
        case "/claim-port":
          return Response.json(handleClaimPort(body as ClaimPortRequest));
        case "/claim-path":
          return Response.json(handleClaimPath(body as ClaimPathRequest));
        case "/release-claims":
          return Response.json(handleReleaseClaims(body as ReleaseClaimsRequest));
        case "/list-claims":
          return Response.json(handleListClaims(body as ListClaimsRequest));
        case "/ask":
          return Response.json(handleAsk(body as AskRequest));
        case "/questions":
          return Response.json(handleQuestions(body as QuestionsRequest));
        case "/answer": {
          const a = handleAnswer(body as AnswerRequest);
          return Response.json(a.body, { status: a.status });
        }
        case "/worktree-add":
          return Response.json(handleWorktreeAdd(body as WorktreeAddRequest));
        case "/worktree-list":
          return Response.json(handleWorktreeList(body as WorktreeListRequest));
        case "/worktree-remove":
          return Response.json(handleWorktreeRemove(body as WorktreeRemoveRequest));
        case "/lease-worktree":
          return Response.json(handleLeaseWorktree(body as LeaseWorktreeRequest));
        case "/release-worktree":
          return Response.json(handleReleaseWorktree(body as ReleaseWorktreeRequest));
        case "/diff":
          return Response.json(await handleDiff(body as DiffRequest));
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  },
});

// Warm the ledger from any previously-indexed files (cheap: unchanged tails are
// skipped by the (size,mtime) guard), then poll for new spend on an interval.
indexTick();
setInterval(indexTick, INDEX_INTERVAL_MS);

log(`listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
