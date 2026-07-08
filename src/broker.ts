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
import { statSync } from "node:fs";
import { getSecret, TOKEN_HEADER } from "../shared/auth.ts";
import {
  priceFor,
  projectDirName,
  sessionFiles,
  parseFileTail,
  resolveTokenToSession,
  findSessionIdByHeuristic,
} from "./costs.ts";
import { SEAT_TOKEN_RE } from "../shared/types.ts";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListSeatsRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  UnregisterRequest,
  ObserveSessionRequest,
  CostsRequest,
  CostsResponse,
  CostRow,
  Seat,
} from "../shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PATROL_PORT ?? "7900", 10);
const DB_PATH = process.env.CLAUDE_PATROL_DB ?? `${process.env.HOME}/.claude-patrol.db`;
const PROJECTS_ROOT = process.env.CLAUDE_PATROL_PROJECTS_ROOT; // undefined -> default below
const ROOT = PROJECTS_ROOT ?? `${process.env.HOME}/.claude/projects`;
// Background cost-index cadence. Low in tests so /costs reflects a just-written
// fixture within a poll; ~12s in production (mirrors cleanStaleSeats).
const INDEX_INTERVAL_MS = parseInt(process.env.CLAUDE_PATROL_INDEX_INTERVAL_MS ?? "12000", 10);
const HOUR_MS = 3_600_000;
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
for (const col of ["role TEXT", "model TEXT", "profile TEXT", "session_id TEXT"]) {
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
db.run(`
  CREATE TABLE IF NOT EXISTS seen_msgs (
    session_id TEXT NOT NULL,
    msg_id TEXT NOT NULL,
    PRIMARY KEY (session_id, msg_id)
  )
`);

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

// Clean up seats whose PID is gone; cap delivered-message table growth.
function cleanStaleSeats() {
  const seats = db.query("SELECT id, pid FROM seats").all() as { id: string; pid: number }[];
  for (const seat of seats) {
    if (!pidAlive(seat.pid)) {
      db.run("DELETE FROM seats WHERE id = ?", [seat.id]);
      // A seat that died without a clean /unregister still gets its run bounded,
      // so seat_runs.ended_at stays accurate for the /costs overlap join.
      db.run("UPDATE seat_runs SET ended_at = ? WHERE seat_id = ? AND ended_at IS NULL", [
        new Date().toISOString(),
        seat.id,
      ]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [seat.id]);
    }
  }
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  db.run("DELETE FROM messages WHERE delivered = 1 AND sent_at < ?", [cutoff]);
}

cleanStaleSeats();
setInterval(cleanStaleSeats, 30_000);

// --- Prepared statements ---

const insertSeat = db.prepare(`
  INSERT INTO seats (id, pid, cwd, git_root, tty, summary, role, model, profile, session_id, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateLastSeen = db.prepare(`UPDATE seats SET last_seen = ? WHERE id = ?`);
const updateSummary = db.prepare(`UPDATE seats SET summary = ? WHERE id = ?`);
const deleteSeat = db.prepare(`DELETE FROM seats WHERE id = ?`);
const insertSeatRun = db.prepare(`
  INSERT INTO seat_runs (seat_id, session_id, seat_token, cwd, role, model, profile, registered_at, ended_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
`);
const endSeatRun = db.prepare(`UPDATE seat_runs SET ended_at = ? WHERE seat_id = ? AND ended_at IS NULL`);
const upsertLedger = db.prepare(`
  INSERT INTO cost_ledger (session_id, attr_session_id, model, bucket_ts, input, output, cache_write, cache_read)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(session_id, model, bucket_ts) DO UPDATE SET
    input = input + excluded.input,
    output = output + excluded.output,
    cache_write = cache_write + excluded.cache_write,
    cache_read = cache_read + excluded.cache_read,
    attr_session_id = excluded.attr_session_id
`);
const seenGet = db.prepare(`SELECT 1 FROM seen_msgs WHERE session_id = ? AND msg_id = ?`);
const seenIns = db.prepare(`INSERT OR IGNORE INTO seen_msgs (session_id, msg_id) VALUES (?, ?)`);
const idxGet = db.prepare(`SELECT bytes_parsed, mtime_ms FROM session_index WHERE file_path = ?`);
const idxSet = db.prepare(`INSERT OR REPLACE INTO session_index (file_path, parent_session_id, bytes_parsed, mtime_ms) VALUES (?, ?, ?, ?)`);
const selectAllSeats = db.prepare(`SELECT * FROM seats`);
const selectSeatsByDirectory = db.prepare(`SELECT * FROM seats WHERE cwd = ?`);
const selectSeatsByGitRoot = db.prepare(`SELECT * FROM seats WHERE git_root = ?`);
const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?, ?, ?, ?, 0)
`);
const selectUndelivered = db.prepare(`
  SELECT m.id, m.from_id, m.to_id, m.text, m.sent_at, m.delivered,
         s.summary AS from_summary, s.cwd AS from_cwd,
         s.role AS from_role, s.model AS from_model
  FROM messages m LEFT JOIN seats s ON s.id = m.from_id
  WHERE m.to_id = ? AND m.delivered = 0
  ORDER BY m.sent_at ASC
`);
const markDelivered = db.prepare(`UPDATE messages SET delivered = 1 WHERE id = ?`);

// --- Seat ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// --- Handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();
  // Re-registration for the same PID replaces the prior row (deleted first, so
  // a seat reclaiming its own session_id below never collides with itself).
  const existing = db.query("SELECT id FROM seats WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    endSeatRun.run(now, existing.id); // bound the replaced seat's run so its history stays consistent
    deleteSeat.run(existing.id);
  }

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

  insertSeat.run(
    id, body.pid, body.cwd, body.git_root, body.tty, body.summary,
    body.role ?? null, body.model ?? null, body.profile ?? null, sessionId,
    now, now
  );

  // Durable run row (survives dereg). session_id is the env-override/guarded
  // fast path; when null the indexer resolves it later via the seat token
  // (Layer 1) or heuristic (Layer 3). Invalid tokens degrade to null.
  const seatToken = body.seat_token && SEAT_TOKEN_RE.test(body.seat_token) ? body.seat_token : null;
  insertSeatRun.run(
    id, sessionId, seatToken, body.cwd,
    body.role ?? null, body.model ?? null, body.profile ?? null, now
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
  // Drop seats whose process has died since last cleanup tick.
  return seats.filter((s) => {
    if (pidAlive(s.pid)) return true;
    deleteSeat.run(s.id);
    return false;
  });
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

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const rows = selectUndelivered.all(body.id) as PollMessagesResponse["messages"];
  for (const m of rows) markDelivered.run(m.id);
  // These rows were undelivered at SELECT and are delivered by this response;
  // report delivered=true (the DB int is 0 until markDelivered above runs).
  return { messages: rows.map((m) => ({ ...m, delivered: true })) };
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
  if (id) {
    // Bound the run (keep the row + its token->session binding) BEFORE dropping
    // the live seat, so the mapping survives for /costs history.
    endSeatRun.run(new Date().toISOString(), id);
    deleteSeat.run(id);
    db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [id]);
  }
}

// v0.2 Layer 2 (exact; any seat incl. manual): a plugin SessionStart hook posts
// what CC hands it. Bind the session to the live run whose claude pid matches
// (seats.pid is now the claude pid — see seat-server), else the newest still-
// unbound live run in the same cwd. Idempotent: re-binding the same value or a
// run that already has a session is a no-op. Safe to ship unused (kill criterion
// in types.ts) — nothing calls it until the hook lands in a later package.
function handleObserveSession(body: ObserveSessionRequest): { ok: boolean } {
  if (!body.session_id) return { ok: false };
  const bind = (runId: number) => db.run("UPDATE seat_runs SET session_id = ? WHERE run_id = ?", [body.session_id, runId]);

  const byPid = db.query(
    "SELECT sr.run_id FROM seat_runs sr JOIN seats s ON s.id = sr.seat_id WHERE s.pid = ? AND sr.ended_at IS NULL ORDER BY sr.registered_at DESC"
  ).get(body.claude_pid) as { run_id: number } | null;
  if (byPid) {
    bind(byPid.run_id);
    return { ok: true };
  }
  const byCwd = db.query(
    "SELECT run_id FROM seat_runs WHERE cwd = ? AND session_id IS NULL AND ended_at IS NULL ORDER BY registered_at DESC"
  ).get(body.cwd) as { run_id: number } | null;
  if (byCwd) {
    bind(byCwd.run_id);
    return { ok: true };
  }
  return { ok: false };
}

// Table reads ONLY — no filesystem walk on the request path (that O(all-history)
// scan was the flagship-view latency bug). Spend is at most one index tick stale.
// Window filtering is at hour-bucket granularity (the ledger's resolution): a
// sub-hour `since`/`until` is floored/rounded to its bucket.
function handleCosts(body: CostsRequest): CostsResponse {
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
          `SELECT session_id, attr_session_id, model, input, output, cache_write, cache_read
           FROM cost_ledger WHERE bucket_ts >= ? AND bucket_ts <= ?`
        ).all(sinceBucket, untilBucket)
      : db.query(
          `SELECT session_id, attr_session_id, model, input, output, cache_write, cache_read
           FROM cost_ledger WHERE bucket_ts >= ?`
        ).all(sinceBucket)
  ) as {
    session_id: string; attr_session_id: string; model: string;
    input: number; output: number; cache_write: number; cache_read: number;
  }[];

  // collapse hour buckets into one row per (session, model), keeping the record's
  // OWN session_id displayed while attributing via attr_session_id.
  const tally = new Map<string, { session_id: string; attr: string; model: string; input: number; output: number; cache_write: number; cache_read: number }>();
  for (const r of ledger) {
    const key = `${r.session_id}\0${r.model}`;
    let t = tally.get(key);
    if (!t) {
      t = { session_id: r.session_id, attr: r.attr_session_id, model: r.model, input: 0, output: 0, cache_write: 0, cache_read: 0 };
      tally.set(key, t);
    }
    t.input += r.input;
    t.output += r.output;
    t.cache_write += r.cache_write;
    t.cache_read += r.cache_read;
  }

  const rows: CostRow[] = [];
  let total = 0;
  for (const t of [...tally.values()].sort((a, b) => a.session_id.localeCompare(b.session_id))) {
    const [pi, po, pcw, pcr] = priceFor(t.model);
    const cost = (t.input * pi + t.output * po + t.cache_write * pcw + t.cache_read * pcr) / 1e6;
    total += cost;
    rows.push({
      seat_id: seatBySession.get(t.attr) ?? null,
      session_id: t.session_id,
      model: t.model,
      input: t.input,
      output: t.output,
      cache_write: t.cache_write,
      cache_read: t.cache_read,
      cost_usd: Math.round(cost * 1e4) / 1e4,
    });
  }
  return { rows, total_usd: Math.round(total * 1e4) / 1e4 };
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

// Index one file: skip if (size,mtime) unchanged; resume from the saved cursor;
// on truncation/rewrite (size < cursor) wipe this file's sessions and reparse
// from 0. seen_msgs makes accounting idempotent regardless of the cursor.
function indexFile(file: string, parentSessionId: string | null) {
  let st: { size: number; mtimeMs: number };
  try {
    st = statSync(file);
  } catch {
    return;
  }
  const size = st.size;
  const mtime = Math.floor(st.mtimeMs);
  const prev = idxGet.get(file) as { bytes_parsed: number; mtime_ms: number } | null;
  let fromByte = prev?.bytes_parsed ?? 0;
  let reset = false;
  if (prev) {
    if (size === prev.bytes_parsed && mtime === prev.mtime_ms) return; // unchanged
    if (size < prev.bytes_parsed) {
      fromByte = 0;
      reset = true;
    }
  }
  const { records, bytesParsed } = parseFileTail(file, fromByte);

  db.transaction(() => {
    if (reset) {
      // The file shrank/was rewritten: drop its prior contribution, then re-add
      // the full current content below (one file == one session's records).
      for (const sid of new Set(records.map((r) => r.sessionId))) {
        db.run("DELETE FROM cost_ledger WHERE session_id = ?", [sid]);
        db.run("DELETE FROM seen_msgs WHERE session_id = ?", [sid]);
      }
    }
    // aggregate this batch's deltas, deduping resume-rewrites via seen_msgs
    const agg = new Map<string, { sid: string; attr: string; model: string; bucket: number; i: number; o: number; cw: number; cr: number }>();
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
        a = { sid: r.sessionId, attr, model: r.model, bucket, i: 0, o: 0, cw: 0, cr: 0 };
        agg.set(key, a);
      }
      a.i += r.input;
      a.o += r.output;
      a.cw += r.cache_write;
      a.cr += r.cache_read;
    }
    for (const a of agg.values()) upsertLedger.run(a.sid, a.attr, a.model, a.bucket, a.i, a.o, a.cw, a.cr);
    idxSet.run(file, parentSessionId, bytesParsed, mtime);
  })();
}

// Resolve runs still missing a session_id. Launcher seats (have a token) bind
// ONLY via Layer-1 content match — never the heuristic, which can't separate
// same-cwd seats; manual seats (no token) fall to Layer-3. Cross-run uniqueness:
// never bind a session another run already owns.
function resolvePendingRuns() {
  const pending = db.query(
    "SELECT run_id, seat_token, cwd, registered_at FROM seat_runs WHERE session_id IS NULL AND ended_at IS NULL"
  ).all() as { run_id: number; seat_token: string | null; cwd: string; registered_at: string }[];
  for (const run of pending) {
    let sid: string | null = null;
    if (run.seat_token) {
      sid = resolveTokenToSession({ cwd: run.cwd, projectsRoot: ROOT, token: run.seat_token });
    } else {
      sid = findSessionIdByHeuristic({ cwd: run.cwd, projectsRoot: ROOT, nowMs: Date.now() });
    }
    if (!sid) continue;
    const owner = db.query("SELECT run_id FROM seat_runs WHERE session_id = ? AND run_id != ?").get(sid, run.run_id) as { run_id: number } | null;
    if (owner) {
      log(`token/heuristic resolved run ${run.run_id} to ${sid} but it is already owned — left unbound`);
      continue;
    }
    db.run("UPDATE seat_runs SET session_id = ? WHERE run_id = ?", [sid, run.run_id]);
  }
}

function indexTick() {
  try {
    for (const [file, , parent] of sessionFiles(ROOT, interestedProjects())) {
      try {
        indexFile(file, parent); // isolate: one unindexable file must not starve the rest
      } catch (e) {
        log(`index error on ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    resolvePendingRuns();
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
      return null;
    case "/heartbeat":
    case "/poll-messages":
      return isSlug(b.id) ? null : "id must be an 8-char [a-z0-9] slug";
    case "/set-summary":
      if (!isSlug(b.id)) return "id must be an 8-char [a-z0-9] slug";
      return isStr(b.summary, MAX_SUMMARY) ? null : `summary must be a string ≤${MAX_SUMMARY} chars`;
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
      if (!isOptIso(b.since)) return "since must be an ISO timestamp";
      if (!isOptIso(b.until)) return "until must be an ISO timestamp";
      return null;
    case "/observe-session":
      if (!isStr(b.session_id, 256, 1)) return "session_id must be a non-empty string";
      if (!isStr(b.transcript_path, MAX_PATH, 1)) return "transcript_path must be a non-empty string";
      if (!isStr(b.cwd, MAX_PATH, 1)) return "cwd must be a non-empty string";
      if (!isPosInt(b.claude_pid)) return "claude_pid must be a positive integer";
      return null;
    default:
      return null; // unknown route 404s below
  }
}

// --- HTTP server ---

const SECRET = getSecret();

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  // Reject oversized POSTs before req.json() ever buffers them.
  maxRequestBodySize: 64 * 1024,
  async fetch(req) {
    const path = new URL(req.url).pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", seats: (selectAllSeats.all() as Seat[]).length });
      }
      return new Response("claude-patrol broker", { status: 200 });
    }

    if (req.headers.get(TOKEN_HEADER) !== SECRET) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    try {
      const body = await req.json();
      const invalid = validate(path, body);
      if (invalid) return Response.json({ error: invalid }, { status: 400 });
      switch (path) {
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
        case "/costs":
          return Response.json(handleCosts(body as CostsRequest));
        case "/observe-session":
          return Response.json(handleObserveSession(body as ObserveSessionRequest));
        case "/unregister":
          handleUnregister(body as UnregisterRequest);
          return Response.json({ ok: true });
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
