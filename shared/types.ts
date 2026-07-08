// Claude-Patrol shared contracts — OWNED BY THE ORCHESTRATOR.
// Implementation seats import from here; changing a contract requires
// escalation, not a local edit.

export type SeatId = string;

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
//   /list-seats       ListSeatsRequest       → Seat[]            (raw array, no wrapper)
//   /send-message     SendMessageRequest     → { ok: boolean; error?: string }
//   /poll-messages    PollMessagesRequest    → PollMessagesResponse
//   /unregister       UnregisterRequest      → { ok: true }
//   /costs            CostsRequest           → CostsResponse
//   /observe-session  ObserveSessionRequest  → { ok: boolean }   (v0.2 Layer 2; see kill criterion)
//   GET /health       (no auth)              → { status: "ok"; seats: number }

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
}

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
}
export interface SendMessageRequest {
  from_id: SeatId | "cli";
  to_id: SeatId;
  text: string;
}
export interface PollMessagesRequest {
  id: SeatId;
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
}
export interface CostsResponse {
  rows: CostRow[];
  total_usd: number;
}

// --- patrol.yaml (launcher config) ---

export interface SeatSpec {
  name: string; // becomes role default + tmux window name
  role?: string; // default: name
  model: string; // REQUIRED — a seat never boots on the default model
  cwd?: string; // default: config file's directory
  backend?: "tmux" | "bg" | "current"; // default tmux; bg = claude --bg headless
  profile?: ProfileSpec | string; // string = named preset: "lite" | "peer" | "full"
  prompt?: string; // optional initial prompt (briefing) passed at launch
  silent?: boolean; // v0.2: skip seat-token marker injection (seat stays on Layer-3 heuristic attribution)
}

export interface ProfileSpec {
  plugins?: string[] | "all" | "none"; // per-seat plugin SET (subset of installed)
  mcp?: "none" | "patrol" | "full"; // patrol = only the patrol seat server
  settings?: Record<string, unknown>; // raw --settings overlay, merged last
}

export interface PatrolConfig {
  seats: SeatSpec[];
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
