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
}
export interface RegisterResponse {
  id: SeatId;
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
