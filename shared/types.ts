// Claude-Patrol shared contracts — OWNED BY THE ORCHESTRATOR.
// Implementation seats import from here; changing a contract requires
// escalation, not a local edit.

export type SeatId = string;

// v0.2.4: semantic seat state (borrowed from herdr's report_agent). Self-reported
// by the seat; drives the dashboard at-a-glance view and the /wait-for primitive.
// "blocked" is the question-inbox trigger — a seat needing a human answer is blocked.
// A seat that never reports reads as "unknown", never guessed.
export type SeatState = "idle" | "working" | "blocked" | "done" | "unknown";

export interface Seat {
  id: SeatId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  role: string | null; // CLAUDE_PATROL_ROLE
  model: string | null; // CLAUDE_PATROL_MODEL
  profile: string | null; // CLAUDE_PATROL_PROFILE (lite|peer|full|custom name)
  // v0.2.4, optional+additive: a stable, readable, broker-unique identifier
  // assigned at register — `role` when unique, else project-prefixed, else
  // hex-suffixed. Shown in status/list/watch/dashboard; `patrol send <handle>`
  // resolves to `id`. The immutable `id` stays the internal key and a fallback;
  // absent on pre-0.2.4 rows => clients fall back to `id`.
  handle?: string;
  state?: SeatState; // v0.2.4, optional+additive: absent on pre-0.2.4 rows => "unknown"
  // v0.2.9: reported by the seat at register and echoed here so `patrol checkpoint`
  // (a different process, with no access to the seat's env) can tell a quiescible seat
  // from an unguarded one AND write the exact file that seat's hook stats. A guarded
  // seat with no lease_file reads as unguarded — never guess the path.
  guarded?: boolean;
  lease_file?: string | null;
  // v0.3: which fleet this seat belongs to. Handles are unique PER FLEET, so two
  // projects may each run a `builder`; message resolution and teardown are
  // fleet-scoped. Absent on pre-0.3 rows, which read as the default fleet.
  fleet?: string | null;
  registered_at: string; // ISO
  last_seen: string; // ISO
}

export interface Message {
  id: number;
  from_id: SeatId;
  to_id: SeatId;
  text: string;
  sent_at: string; // ISO
  delivered: boolean;
}

// Sender context joined by the broker at poll time — receivers never do a
// follow-up list call per message.
export interface DeliveredMessage extends Message {
  from_summary: string | null;
  from_cwd: string | null;
  from_role: string | null;
  from_model: string | null;
}

// Per-seat cost snapshot; parsed from ~/.claude/projects session JSONL,
// INCLUDING <project>/<session>/subagents/*.jsonl (the 63%-undercount bug
// class — see Fable Hijack benchmarks).
export interface CostRow {
  seat_id: SeatId | null; // null = unattributed session in window
  session_id: string;
  model: string;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  cost_usd: number;
  // v0.2.4, optional+additive: which wallet this spend drew from. Written by the
  // indexer from the transcript's `entrypoint` (sdk-cli/sdk-py => agent-sdk), and
  // "external" for codex seats that have no transcript. Absent on pre-0.2.4
  // ledgers, which read as "subscription" downstream — never sum across sources.
  billing_source?: BillingSource;
  // v0.3: the cache re-encode tax. A prompt cache expires while a seat sits idle (an
  // orchestrator waiting on a worker is the classic case), and the NEXT turn re-encodes
  // an unchanged history at the cache-WRITE rate instead of reading it back cheap. These
  // count the writes that look like a rebuild rather than a first-time prefix — see
  // REBUILD detection in costs.ts. Heuristic and directional, never ground truth.
  cache_rebuilds?: number;
  cache_rebuild_tokens?: number;
}

// --- Broker HTTP API (localhost only, POST + x-patrol-token; GET /health open) ---
// Port: CLAUDE_PATROL_PORT, default 7900 (coexists with legacy claude-peers on 7899)
// DB: CLAUDE_PATROL_DB, default ~/.claude-patrol.db
// Secret: CLAUDE_PATROL_SECRET_FILE, default ~/.claude-patrol.secret (0600, auto-created)
//
// FROZEN ROUTE MAP (request → response, all POST unless noted):
//   /register         RegisterRequest        → RegisterResponse
//   /heartbeat        HeartbeatRequest       → { ok: true }
//   /set-summary      SetSummaryRequest      → { ok: true }
//   /set-state        SetStateRequest        → { ok: true }       (v0.2.4 semantic seat state)
//   /rename           RenameRequest          → RenameResponse     (v0.2.4 readable seat handle)
//   /wait-for         WaitForRequest         → WaitForResponse    (v0.2.4 block until a seat's state)
//   /list-seats       ListSeatsRequest       → Seat[]            (raw array, no wrapper)
//   /send-message     SendMessageRequest     → { ok: boolean; error?: string }
//   /poll-messages    PollMessagesRequest    → PollMessagesResponse  (v0.2.3: LEASES rows, does not deliver)
//   /ack              AckRequest             → { ok: true }          (v0.2.3: marks leased messages delivered)
//   /unregister       UnregisterRequest      → { ok: true }
//   /costs            CostsRequest           → CostsResponse
//   /observe-session  ObserveSessionRequest  → { ok: boolean }   (v0.2 Layer 2; see kill criterion)
//   /stats            StatsRequest           → StatsResponse     (v0.2 telemetry)
//   /log              LogRequest             → LogResponse       (v0.2.1 message history for `patrol watch`)
//   /claim-port       ClaimPortRequest       → ClaimPortResponse (v0.2.4 localhost collision fix)
//   /claim-path       ClaimPathRequest       → ClaimPathResponse (v0.2.4 file ownership; denies on conflict)
//   /release-claims   ReleaseClaimsRequest   → { ok: true }      (v0.2.4)
//   /list-claims      ListClaimsRequest      → PathClaim[]       (v0.2.4 raw array)
//   /ask              AskRequest             → AskResponse       (v0.2.5 seat raises a question for the human)
//   /questions        QuestionsRequest       → Question[]        (v0.2.5 open questions for the inbox)
//   /answer           AnswerRequest          → { ok: true }      (v0.2.5 human answers → routed back to the seat)
//   /worktree-add     WorktreeAddRequest     → { ok: true }      (v0.2.6 record a seat→worktree association)
//   /worktree-list    WorktreeListRequest    → Worktree[]        (v0.2.6 raw array)
//   /worktree-remove  WorktreeRemoveRequest  → { ok: true }      (v0.2.6 drop the association; git tree untouched)
//   /lease-worktree   LeaseWorktreeRequest   → LeaseWorktreeResponse (v0.2.9 quiesce a seat for checkpoint)
//   /release-worktree ReleaseWorktreeRequest → { ok: true }      (v0.2.9 release it)
//   /dash-token       (full secret only)     → { token: string }  (v0.2.7 mint a scoped read+answer dashboard nonce)
//   GET /dashboard?t= (valid dash nonce)     → text/html          (v0.2.7: nonce-gated; injects the NONCE, not the secret)
//   GET /health       (no auth)              → { status: "ok"; seats: number }

// --- v0.2.4: billing source ---
// The June 15 2026 split: programmatic launches (`claude -p`, Agent SDK, CI)
// draw a SEPARATE monthly Agent-SDK credit at API rates, not the interactive
// subscription pool, and hard-stop when exhausted unless extra usage is on.
// Interactive sessions — including `--background`, /bg and the agents dashboard
// — still bill the subscription pool. Codex seats bill OpenAI entirely.
// These pools MUST NOT be summed into one number: `patrol status` reporting a
// single total would misstate both. Derived from backend, never configured.
export type BillingSource = "subscription" | "agent-sdk" | "external";

export function billingSource(backend: SeatSpec["backend"]): BillingSource {
  switch (backend) {
    case "codex":
      return "external";
    case "bg":
    case "headless":
      return "agent-sdk";
    default:
      return "subscription";
  }
}

// --- v0.2.4: port + path claims ---
// Both are leases keyed to a seat and reaped by the same stale-seat sweep that
// already purges dead seats — a claim outliving its holder is the failure mode
// that makes any locking scheme worse than none.
// v0.2.4 seat state. A seat reports its own state; /set-state is idempotent.
export interface SetStateRequest {
  id: SeatId;
  state: SeatState;
}

// v0.2.4 explicit rename. The broker slugifies + dedupes `name` and returns the
// ACTUAL handle it assigned (which may differ, e.g. a "-2" suffix on collision).
export interface RenameRequest {
  id: SeatId;
  name: string;
}
export interface RenameResponse {
  ok: true;
  handle: string;
}

// v0.2.4 /wait-for (herdr's agent.wait): the caller blocks until `target` reaches
// any state in `until`, or `timeout_ms` elapses. Long-poll on the broker — it holds
// the response open, it does not busy-spin. reached=false on timeout, and `state`
// carries the target's last-known state either way (so the caller can branch).
export interface WaitForRequest {
  id: SeatId; // the waiter (for auth + logging)
  target: SeatId;
  until: SeatState[]; // any-of
  timeout_ms: number;
}
export interface WaitForResponse {
  reached: boolean;
  state: SeatState;
}

// v0.2.5 question inbox: a seat raises a question the HUMAN must answer; it surfaces
// in the dashboard/CLI inbox instead of being buried in one of N terminals. The human
// answers and the broker routes the answer back to the asking seat as a normal message.
// Pairs with SeatState "blocked": a seat that asks typically sets itself blocked.
export interface Question {
  id: number;
  from_id: SeatId;
  from_handle: string | null; // resolved at ask time for display
  text: string;
  asked_at: string; // ISO
  answered: boolean;
  answer: string | null;
  answered_at: string | null; // ISO
}
export interface AskRequest {
  id: SeatId; // the asking seat
  text: string;
}
export interface AskResponse {
  ok: true;
  question_id: number;
}
export interface QuestionsRequest {
  open_only?: boolean; // default true — only unanswered
}
// The broker sends `text` to the asking seat as a message from "human", marks the
// question answered, and records answered_at.
export interface AnswerRequest {
  question_id: number;
  text: string;
}

// v0.2.6 worktree tracking: git is the source of truth for the tree; the broker only
// records the seat→worktree association so status/dashboard can show "seat → branch".
// endSeat drops the association but NEVER deletes the git worktree (unmerged work).
export interface Worktree {
  seat_id: SeatId;
  path: string; // absolute worktree path
  branch: string;
  base_commit: string; // the commit it branched from (for a clean checkpoint rebase)
  created_at: string; // ISO
}
export interface WorktreeAddRequest {
  id: SeatId;
  path: string;
  branch: string;
  base_commit: string;
}
export interface WorktreeListRequest {
  id?: SeatId; // omit = all seats
}
export interface WorktreeRemoveRequest {
  id: SeatId;
  path: string;
}

// v0.2.9 checkpoint lease — MUTUAL EXCLUSION, not detection. Three rounds of fences
// each lost the race to a concurrent writer (a fence after `worktree remove` can't even
// read the seat's HEAD — the tree is gone). So the seat is quiesced instead: while a
// lease is held, its PreToolUse guard hook DENIES every mutating tool.
//
// The hook's fast path is a FILE, not this route: PreToolUse fires on every tool call,
// so a broker round-trip per call would tax the whole fleet. The launcher hands each
// guarded seat a lease path via LEASE_FILE_ENV; the hook just stats it. These routes are
// the broker's record of who holds what (status/dashboard visibility + expiry sweeping).
//
// expires_at is load-bearing: a checkpoint killed between acquire and release must NOT
// wedge a seat forever, so the hook treats an EXPIRED lease as absent (fail-open on
// staleness — a wedged seat is worse than a missed fence).
export const LEASE_FILE_ENV = "CLAUDE_PATROL_LEASE_FILE";
export const LEASE_TTL_SECONDS = 120; // >> a checkpoint, << a work session

// v0.2.9.1: an opaque per-CHECKPOINT token. Keying ownership on seat_id ALONE made a
// second checkpoint of the same seat read as a renewal, so either process could release
// the row and file the other was still running under — un-quiescing the seat mid-merge.
// The token is minted per acquire, so "the same seat again" is a DIFFERENT holder and is
// refused. Minted BROKER-side: the broker is the arbiter, and a client-minted token would
// let a racing client present one it was never issued.
export const LEASE_TOKEN_RE = /^cpl-[0-9a-f]{32}$/;

export interface LeaseWorktreeRequest {
  id: SeatId;
  path: string; // the worktree being checkpointed (canonical)
  token?: string; // absent = fresh acquire (broker mints one); present = RENEW, and must match the stored token
}
export interface LeaseWorktreeResponse {
  ok: boolean;
  expires_at?: string; // ISO; absent when ok:false
  token?: string; // the holder's proof, required for renew AND release; absent when ok:false
  error?: string; // e.g. the seat is not guarded, or someone else holds the lease
}
export interface ReleaseWorktreeRequest {
  id: SeatId;
  path: string;
  // REQUIRED, not optional: an optional token re-opens the hole, since any caller could
  // then release by simply omitting it. A checkpoint that never acquired (the --force
  // path) therefore must NOT call release at all — it holds nothing.
  token: string;
}

export interface ClaimPortRequest {
  id: SeatId;
  count?: number; // default 1
}
export interface ClaimPortResponse {
  ports: number[];
}

export interface PathClaim {
  path: string; // absolute, realpath-resolved at claim time
  owner_id: SeatId;
  owner_role: string | null;
  claimed_at: string; // ISO
}
export interface ClaimPathRequest {
  id: SeatId;
  paths: string[];
}
// Advisory by default: a denied claim reports the holder so the caller can
// coordinate. Enforcement is opt-in via the seat's PreToolUse deny hook.
export interface ClaimPathResponse {
  granted: string[];
  denied: PathClaim[]; // each carries the CURRENT holder, not the requester
}
export interface ReleaseClaimsRequest {
  id: SeatId;
  paths?: string[]; // omit = release all this seat holds
}
export interface ListClaimsRequest {
  git_root?: string | null;
}

// --- v0.2 cost attribution: launcher-issued seat token (Layer 1, primary) ---
// The launcher injects the SAME token into the seat's env and its launch
// prompt; the broker resolves token → session by substring match over the
// seat's project-dir jsonl files (ANY record type — spike showed the marker
// also lands in last-prompt/queue-operation records). Both halves import
// these constants; the format is frozen — a drift here silently kills exact
// attribution.
export const SEAT_TOKEN_ENV = "CLAUDE_PATROL_SEAT_TOKEN";
export function seatMarker(token: string): string {
  return `[patrol-seat: ${token}]`;
}
// token format: "cp-" + 8 lowercase hex chars, e.g. cp-0375a012
export const SEAT_TOKEN_RE = /^cp-[0-9a-f]{8}$/;

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  role?: string | null;
  model?: string | null;
  profile?: string | null;
  session_id?: string | null; // CC session id when discoverable; enables exact cost attribution
  seat_token?: string | null; // v0.2 Layer-1 marker token (SEAT_TOKEN_ENV); broker content-matches it to a session
  name?: string | null; // v0.2.4: requested handle; broker slugifies + dedupes it. Falls back to role, then hex.
  budget_usd?: number | null; // v0.2.6: per-seat spend cap; launcher passes SeatSpec.budget_usd through.
  budget_alert_to?: string | null; // v0.2.7: fleet PatrolConfig.budget_alert_to, so the broker's recipient resolver can honor a configured handle/role (not just the orchestrator default).
  // v0.2.9: true when the launcher installed the checkpoint-guard PreToolUse hook, so
  // this seat's writes can actually be paused. `patrol checkpoint` REFUSES an unguarded
  // seat (adapter seats, hand-launched sessions) rather than pretend a fence is a lease.
  guarded?: boolean | null;
  // v0.2.9: the absolute lease-file path the launcher handed this seat (LEASE_FILE_ENV).
  // The seat reports it because ONLY the seat knows its own env — `patrol checkpoint`
  // runs in a different process and must write the exact file this seat's hook stats.
  // Deriving it from a shared convention instead would fail silently on any drift: the
  // hook would watch one path while checkpoint wrote another, and the lease would never
  // fire while appearing to work.
  lease_file?: string | null;
  fleet?: string | null; // v0.3: the fleet this seat launched into
  // v0.3 stable identity across restarts: fleet + seat name, unchanged by a crash or a
  // relaunch. The broker's stale sweep deletes a dead seat's undelivered mail and a
  // restarted seat used to return under a NEW id, so nothing could be resurfaced —
  // consumer-crash redelivery was blocked on exactly this. A returning seat presenting
  // the same stable_key re-claims its prior identity and its unacked mail is redelivered
  // rather than purged.
  stable_key?: string | null;
}

// v0.2 Layer 2 (exact attribution for manual seats): a plugin SessionStart
// hook POSTs what CC hands it. KILL CRITERION: if this CC build doesn't pass
// session_id/transcript_path to SessionStart hooks, or claude_pid can't join a
// seat, Layer 2 is dropped and this route stays unused (Layers 1+3 stand).
export interface ObserveSessionRequest {
  session_id: string;
  transcript_path: string;
  cwd: string;
  claude_pid: number; // the hook's $PPID = the claude process
}
export interface RegisterResponse {
  id: SeatId;
  // set when the broker's uniqueness guard nulled a session_id claim already
  // held by a live seat (the claimant's costs stay unattributed)
  session_id_rejected?: boolean;
  // v0.3 capability token: the seat's PROOF of identity, minted here and presented
  // on every seat-owned route thereafter. Until now those routes trusted `body.id`,
  // so any holder of the machine-wide secret could set another seat's state, release
  // its claims, ack its mail, or burn ports charged to it — the finding three
  // consecutive adversarial reviews kept returning. `body.id` becomes a claim the
  // token must match. The human's shared secret keeps full scope: the threat model
  // is seat-spoofs-seat, not the operator who owns the 0600 file.
  //
  // NAMED `capability_token`, NOT `seat_token`, deliberately: RegisterRequest.seat_token
  // is already taken by the v0.2 Layer-1 COST-ATTRIBUTION marker (`cp-…`), an entirely
  // different credential. Shipping both under one name is how v0.3 landed a complete
  // enforcement boundary that no production seat ever crossed — every client kept
  // authenticating with the machine-wide secret, so the default-deny allowlist and the
  // subject checks were dead code. Two credentials, two names.
  capability_token?: string;
}

// v0.3 auth scopes, generalizing the v0.2.7 dash-nonce gate (which already resolved a
// presented token to full|dash|none once and gated each route by it).
//   full     — the shared secret: the operator, every route
//   seat     — a capability token: only routes that seat owns, and only for itself
//   dash     — the dashboard nonce: read routes + /answer, loopback origin only
export type Scope = "full" | "seat" | "dash" | "none";

export interface HeartbeatRequest {
  id: SeatId;
}
export interface SetSummaryRequest {
  id: SeatId;
  summary: string;
}
export interface ListSeatsRequest {
  scope: "machine" | "directory" | "repo";
  cwd: string;
  git_root: string | null;
  exclude_id?: SeatId;
  // v0.3: restrict to one fleet. Omitted = every fleet (what the dashboard wants);
  // the CLI passes the caller's own fleet so `patrol send builder` can never reach
  // another project's builder by accident.
  fleet?: string | null;
}
export interface SendMessageRequest {
  from_id: SeatId | "cli";
  to_id: SeatId;
  text: string;
}
export interface PollMessagesRequest {
  id: SeatId;
}
// v0.2.3 lease/ack delivery. /poll-messages now LEASES rows (sets leased_at,
// returns them) rather than marking them delivered — a message is delivered
// ONLY when the consumer /ack's it after the reply/notification is durably
// out. Unacked leases expire after LEASE_TTL and redeliver, so a consumer that
// dies mid-work (a codex turn can run 10 min) loses nothing. message_ids are
// the DeliveredMessage.id values from the poll batch; acking an unknown/foreign
// id is a no-op.
export interface AckRequest {
  id: SeatId;
  message_ids: number[];
}
// Dereg by id (seat-server shutdown) or by pid (SessionEnd hook: the hook's
// $PPID is the registered Claude process pid). Exactly one required.
export interface UnregisterRequest {
  id?: SeatId;
  pid?: number;
}
export interface PollMessagesResponse {
  messages: DeliveredMessage[];
}
export interface CostsRequest {
  since?: string; // ISO; default: since broker start
  until?: string;
  // NOTE: /costs reads the hour-bucketed ledger, so since/until are effectively
  // floored to the hour (boundary hour over-included). Record-exact windows live
  // in the pure computeCosts path; ledger is rebuildable if finer buckets are
  // ever needed.
}
export interface CostsResponse {
  rows: CostRow[];
  total_usd: number;
  // v0.2.4, optional+additive: per-wallet totals for the `patrol status` pool
  // split. Present once the broker ledger carries billing_source; absent = a
  // single-pool caller. total_usd stays the grand total, but a UI MUST show the
  // three pools separately — they are billed against different accounts.
  by_source?: Partial<Record<BillingSource, number>>;
  // v0.3: fleet-wide cache re-encode tax. Reported in BOTH token units and dollars —
  // tokens because they are what was actually measured, dollars because that is the
  // decision unit. A fleet whose orchestrator waits on long-running seats can pay this
  // repeatedly without any line item ever naming it.
  cache_tax?: {
    rebuilds: number;
    rebuild_tokens: number;
    tax_usd: number;
  };
}

// --- v0.2 telemetry (/stats) — the evidence layer for the cost claims ---
// Wake-ups are the unit that costs money: every delivered notification wakes
// the seat for a full turn at full context price. messages/notifications is
// the coalescing ratio the README claims; bound_via measures which
// attribution layer actually fired in practice.

export type BoundVia = "token" | "observe" | "heuristic" | "env";

export interface StatsRequest {
  since?: string; // ISO; default: since broker start
  until?: string;
}
export interface SeatStats {
  seat_id: SeatId;
  role: string | null;
  model: string | null;
  live: boolean;
  bound_via: BoundVia | null; // null = session never bound (unattributed seat)
  notifications: number; // paid wake-ups (poll batches delivered)
  messages: number; // messages inside those batches
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  cost_usd: number;
}
export interface StatsResponse {
  seats: SeatStats[];
  totals: {
    notifications: number;
    messages: number;
    cost_usd: number;
    unattributed_usd: number; // spend in window no seat claimed
  };
}

// --- v0.2.1 message history (/log) — feeds the `patrol watch` TUI ---
// Reads the broker's messages table (delivered rows are retained 7 days, so
// that's the history window). Sender AND recipient get role/model context
// joined from the latest seat_runs row per seat, so dead seats still render.

export interface LogRequest {
  after_id?: number; // return only messages with id > after_id (poll cursor)
  limit?: number; // default 200, capped at 500
}
export interface LogMessage extends Message {
  from_role: string | null;
  from_model: string | null;
  to_role: string | null;
  to_model: string | null;
}
export interface LogResponse {
  messages: LogMessage[];
  latest_id: number; // highest message id known to the broker (cursor anchor)
}

// --- patrol.yaml (launcher config) ---

export interface SeatSpec {
  name: string; // becomes role default + tmux window name
  role?: string; // default: name
  model: string; // REQUIRED — a seat never boots on the default model
  cwd?: string; // default: config file's directory
  // default tmux; bg = claude --bg headless (outbound-only: no push-wake, see
  // SETUP known limits); codex = v0.2.2 adapter seat — a bun daemon that
  // registers with the broker and drives ONE persistent `codex exec resume`
  // thread: each inbound patrol message becomes a codex turn, stdout returns
  // via patrol send to the requester. model: then names the codex model
  // (label + adapter --model flag). Spike-verified 2026-07-11: thread memory
  // survives resume; fresh spawn ≈ 15.8k tokens, resumed turns pay a growing
  // half-price prefix — the adapter retires and restarts its thread past a
  // budget (see CODEX_THREAD_RETIRE_TOKENS in the adapter).
  // v0.2.4: `headless` is `bg` done properly — a bun adapter daemon (same shape
  // as the codex adapter) driving repeated `claude -p --resume` turns over a
  // FIFO, settling each message with /ack. It exists because a headless session
  // CANNOT receive channel pushes (consent gate; live-verified 2026-07-10), so
  // delivery must be pull-based. `bg` stays as the deprecated outbound-only
  // form. BILLING DIFFERS BY BACKEND — see billingSource() below.
  backend?: "tmux" | "bg" | "current" | "codex" | "headless";
  // v0.2.4: ports the seat needs. The broker allocates them from PORT_RANGE and
  // exports PATROL_PORT (+ PATROL_PORT_1..N) into the seat env, so parallel
  // seats never collide on localhost:3000. Released when the seat dies.
  ports?: number;
  profile?: ProfileSpec | string; // string = named preset: "lite" | "peer" | "full"
  prompt?: string; // optional initial prompt (briefing) passed at launch
  silent?: boolean; // v0.2: skip seat-token marker injection (seat stays on Layer-3 heuristic attribution)
  // v0.2.3, codex seats only: sandbox the codex process runs under. DEFAULT
  // read-only — a codex seat cannot touch files unless the yaml opts in. The
  // ADAPTER builds the codex argv, so a message can never escalate this. A
  // write-enabled seat additionally runs a vetted PreToolUse deny-hook that
  // blocks destructive commands (rm -rf, git push --force, curl|sh, out-of-cwd
  // writes) — spike-verified 2026-07-14 to block even under workspace-write.
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  // v0.2.6: per-seat spend cap in USD. When the seat's cumulative cost crosses it,
  // the broker pings the alert recipient ONCE (not a hard stop — Patrol observes
  // spend, it does not gate the model). Absent = no cap.
  budget_usd?: number;
}

export interface ProfileSpec {
  plugins?: string[] | "all" | "none"; // per-seat plugin SET (subset of installed)
  mcp?: "none" | "patrol" | "full"; // patrol = only the patrol seat server
  settings?: Record<string, unknown>; // raw --settings overlay, merged last
}

export interface PatrolConfig {
  seats: SeatSpec[];
  // v0.3: the fleet this config launches. Optional — defaults to the git-root
  // basename — so an existing patrol.yaml keeps working unchanged. A fleet is the
  // isolation unit: its own tmux session (`patrol-<fleet>`), its own handle
  // namespace, its own teardown. Before this, TMUX_SESSION was the constant
  // "patrol", so `patrol down` in ANY project killed EVERY project's seats.
  fleet?: string;
  // v0.2.6: fleet-wide spend cap + who hears a crossing. budget_alert_to is a handle
  // or role (default: the seat whose role is "orchestrator"). A per-seat
  // SeatSpec.budget_usd overrides this for that seat.
  budget_usd?: number;
  budget_alert_to?: string;
}

// $/MTok list prices: (input, output, cache_write, cache_read).
// Keep in sync with token-audit.py in the Fable Hijack repo.
export const PRICES: Record<string, [number, number, number, number]> = {
  fable: [25.0, 125.0, 31.25, 2.5],
  opus: [5.0, 25.0, 6.25, 0.5],
  sonnet: [3.0, 15.0, 3.75, 0.3],
  haiku: [1.0, 5.0, 1.25, 0.1],
};
export const DEFAULT_PRICE: [number, number, number, number] = [5.0, 25.0, 6.25, 0.5];
