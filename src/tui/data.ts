// Pure data layer for `patrol watch`. NO ink/react imports — every export here
// is a plain function so tests/tui.test.ts can exercise the reducer, the target
// cycling, and the row formatting with no terminal. Fetching lives in the app
// (brokerPost from src/commands/_client.ts); this file only transforms results.
import type { Seat, SeatStats, LogMessage, SeatId, StatsResponse } from "../../shared/types.ts";

// Ring-buffer cap. The /log contract retains 7 days of history; the TUI only
// keeps the most recent MSG_CAP in memory so a long-lived watch can't grow
// unbounded.
export const MSG_CAP = 500;

// ---- /log ring buffer (id-deduped, cursor-advancing) ------------------------

export interface LogState {
  messages: LogMessage[]; // ascending by id; newest last (rendered at the bottom)
  seenIds: Set<number>;
  cursor: number; // after_id for the next /log poll
}

export function emptyLog(): LogState {
  return { messages: [], seenIds: new Set(), cursor: 0 };
}

// Merge a /log batch. New (unseen) messages are appended and the buffer trimmed
// to MSG_CAP from the front (oldest dropped). The cursor advances to the highest
// id in the batch — NOT to latest_id — so a limit-capped batch pages forward
// without skipping the gap between the last returned id and latest_id. When the
// batch is empty (nothing new), the cursor jumps to latest_id.
export function mergeLog(prev: LogState, batch: LogMessage[], latestId: number): LogState {
  const fresh = batch.filter((m) => !prev.seenIds.has(m.id));

  let messages = prev.messages;
  let seenIds = prev.seenIds;
  if (fresh.length > 0) {
    messages = [...prev.messages, ...fresh].sort((a, b) => a.id - b.id);
    if (messages.length > MSG_CAP) messages = messages.slice(messages.length - MSG_CAP);
    seenIds = new Set(messages.map((m) => m.id));
  }

  const maxBatchId = batch.reduce((mx, m) => Math.max(mx, m.id), prev.cursor);
  const cursor = batch.length > 0 ? maxBatchId : Math.max(prev.cursor, latestId);

  return { messages, seenIds, cursor };
}

// ---- /stats indexing --------------------------------------------------------

export function indexStats(seats: SeatStats[]): Map<SeatId, SeatStats> {
  return new Map(seats.map((s) => [s.seat_id, s]));
}

// ---- target cycling ---------------------------------------------------------

// Ordered ids of seats whose process is alive. `isAlive` is injected so this
// stays pure/testable (the app passes pidAlive from _client.ts). Ordered by
// registration time for a stable Tab cycle.
export function liveTargets(seats: Seat[], isAlive: (pid: number) => boolean): SeatId[] {
  return seats
    .filter((s) => isAlive(s.pid))
    .sort((a, b) => (a.registered_at < b.registered_at ? -1 : a.registered_at > b.registered_at ? 1 : 0))
    .map((s) => s.id);
}

// Keep the current target valid: if it died (or was never set), fall to the
// first live seat. Called every poll so a dead target auto-advances.
export function resolveTarget(current: SeatId | null, live: SeatId[]): SeatId | null {
  if (current && live.includes(current)) return current;
  return live[0] ?? null;
}

// Tab: advance to the next live seat, wrapping. A dead/unset current jumps to
// the first live seat; an empty fleet yields null.
export function cycleTarget(current: SeatId | null, live: SeatId[]): SeatId | null {
  if (live.length === 0) return null;
  if (!current) return live[0]!;
  const i = live.indexOf(current);
  if (i === -1) return live[0]!;
  return live[(i + 1) % live.length]!;
}

// ---- row formatting ---------------------------------------------------------

export function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

export function roleTag(role: string | null): string {
  return role ?? "-";
}

// ~-shorten a cwd against the given home dir (app passes os.homedir()).
export function shortenCwd(cwd: string, home: string): string {
  if (home && (cwd === home || cwd.startsWith(home + "/"))) return "~" + cwd.slice(home.length);
  return cwd;
}

// HH:MM:SS in local time; a bad timestamp renders as placeholder rather than
// "NaN:NaN:NaN".
export function hhmmss(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Single-line rendering of a message: `HH:MM:SS from (role) → to (role)  text`.
// The app renders coloured segments; this plain form is what tests assert on.
export function msgLine(m: LogMessage): string {
  const from = `${shortId(m.from_id)} (${roleTag(m.from_role)})`;
  const to = `${shortId(m.to_id)} (${roleTag(m.to_role)})`;
  return `${hhmmss(m.sent_at)} ${from} → ${to}  ${m.text}`;
}

// Fleet totals for the header strip; null-safe over an absent /stats response.
export function headerTotals(totals: StatsResponse["totals"] | null): {
  spendUsd: number;
  wakes: number;
} {
  return { spendUsd: totals?.cost_usd ?? 0, wakes: totals?.notifications ?? 0 };
}
