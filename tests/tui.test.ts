// Unit tests for the pure watch data layer (src/tui/data.ts). No terminal, no
// ink — the rendered TUI is verified live by the orchestrator. Covers the ring
// buffer (cap, dedupe, cursor), target cycling (incl. dead-target auto-advance
// and empty fleet), and row formatting.
import { test, expect } from "bun:test";
import type { LogMessage, Seat } from "../shared/types.ts";
import {
  MSG_CAP,
  emptyLog,
  mergeLog,
  liveTargets,
  resolveTarget,
  cycleTarget,
  shortId,
  shortenCwd,
  hhmmss,
  msgLine,
  headerTotals,
} from "../src/tui/data.ts";
import { clampCursor } from "../src/tui/components/TextInput.tsx";

function msg(id: number, over: Partial<LogMessage> = {}): LogMessage {
  return {
    id,
    from_id: "aaaa1111bbbb2222",
    to_id: "cccc3333dddd4444",
    text: `m${id}`,
    sent_at: new Date(2026, 0, 2, 3, 4, 5).toISOString(),
    delivered: true,
    from_role: "exec",
    from_model: "opus",
    to_role: "orch",
    to_model: "fable",
    ...over,
  };
}

function seat(id: string, pid: number, registered_at: string): Seat {
  return {
    id,
    pid,
    cwd: "/x",
    git_root: null,
    tty: null,
    summary: "",
    role: null,
    model: null,
    profile: null,
    registered_at,
    last_seen: registered_at,
  };
}

// ---- ring buffer ----

test("mergeLog appends new messages ascending and advances the cursor to the max batch id", () => {
  const s = mergeLog(emptyLog(), [msg(1), msg(2), msg(3)], 3);
  expect(s.messages.map((m) => m.id)).toEqual([1, 2, 3]);
  expect(s.cursor).toBe(3);
});

test("mergeLog dedupes ids that overlap the buffer, keeping only the fresh tail", () => {
  const a = mergeLog(emptyLog(), [msg(1), msg(2), msg(3)], 3);
  const b = mergeLog(a, [msg(2), msg(3), msg(4)], 4); // 2,3 already seen
  expect(b.messages.map((m) => m.id)).toEqual([1, 2, 3, 4]);
  expect(b.cursor).toBe(4);
});

test("mergeLog caps the buffer at MSG_CAP, dropping the oldest", () => {
  let s = emptyLog();
  const total = MSG_CAP + 100;
  for (let i = 1; i <= total; i++) s = mergeLog(s, [msg(i)], i);
  expect(s.messages.length).toBe(MSG_CAP);
  expect(s.messages[0]!.id).toBe(total - MSG_CAP + 1); // oldest retained
  expect(s.messages.at(-1)!.id).toBe(total); // newest retained
  expect(s.cursor).toBe(total);
});

test("mergeLog on an empty batch jumps the cursor to latest_id without touching messages", () => {
  const a = mergeLog(emptyLog(), [msg(5)], 5);
  const b = mergeLog(a, [], 42);
  expect(b.messages.map((m) => m.id)).toEqual([5]);
  expect(b.cursor).toBe(42);
});

test("mergeLog with a fully-overlapping batch still advances the cursor (no refetch loop)", () => {
  const a = mergeLog(emptyLog(), [msg(1), msg(2)], 2);
  const b = mergeLog(a, [msg(1), msg(2)], 2); // all seen
  expect(b.messages.map((m) => m.id)).toEqual([1, 2]);
  expect(b.cursor).toBe(2);
});

// ---- target cycling ----

const A = "aaaaaaaa1111";
const B = "bbbbbbbb2222";
const C = "cccccccc3333";

test("liveTargets filters dead pids and orders by registration time", () => {
  const alive = (pid: number) => pid !== 999;
  const seats = [
    seat(B, 2, "2026-07-08T10:00:02Z"),
    seat(A, 1, "2026-07-08T10:00:01Z"),
    seat(C, 999, "2026-07-08T10:00:03Z"), // dead
  ];
  expect(liveTargets(seats, alive)).toEqual([A, B]);
});

test("cycleTarget advances and wraps", () => {
  const live = [A, B, C];
  expect(cycleTarget(A, live)).toBe(B);
  expect(cycleTarget(C, live)).toBe(A); // wrap
  expect(cycleTarget(null, live)).toBe(A);
});

test("cycleTarget on an empty fleet is null; a dead current jumps to the first live", () => {
  expect(cycleTarget(A, [])).toBeNull();
  expect(cycleTarget("dead-id", [A, B])).toBe(A);
});

test("resolveTarget keeps a live target but auto-advances a dead one", () => {
  expect(resolveTarget(A, [A, B])).toBe(A);
  expect(resolveTarget(C, [A, B])).toBe(A); // C died -> first live
  expect(resolveTarget(A, [])).toBeNull(); // empty fleet
  expect(resolveTarget(null, [B, A])).toBe(B);
});

// ---- formatting ----

test("shortId slices to 8 but leaves short ids (e.g. 'cli') intact", () => {
  expect(shortId("aaaa1111bbbb2222")).toBe("aaaa1111");
  expect(shortId("cli")).toBe("cli");
});

test("shortenCwd replaces the home prefix with ~ and leaves other paths alone", () => {
  expect(shortenCwd("/Users/alex/Projects/p", "/Users/alex")).toBe("~/Projects/p");
  expect(shortenCwd("/Users/alex", "/Users/alex")).toBe("~");
  expect(shortenCwd("/opt/x", "/Users/alex")).toBe("/opt/x");
  expect(shortenCwd("/Users/alexander/x", "/Users/alex")).toBe("/Users/alexander/x"); // not a path-boundary match
});

test("hhmmss formats local time and guards a bad timestamp", () => {
  const iso = new Date(2026, 0, 2, 3, 4, 5).toISOString();
  expect(hhmmss(iso)).toBe("03:04:05");
  expect(hhmmss("not-a-date")).toBe("--:--:--");
});

test("msgLine renders time, from/to with roles, the arrow, and the text", () => {
  const line = msgLine(msg(7, { text: "ship it" }));
  expect(line).toBe("03:04:05 aaaa1111 (exec) → cccc3333 (orch)  ship it");
});

test("msgLine falls back to '-' for a null role", () => {
  expect(msgLine(msg(8, { from_role: null }))).toContain("aaaa1111 (-)");
});

test("headerTotals is null-safe", () => {
  expect(headerTotals(null)).toEqual({ spendUsd: 0, wakes: 0 });
  expect(
    headerTotals({ notifications: 4, messages: 12, cost_usd: 1.3, unattributed_usd: 0.05 }),
  ).toEqual({ spendUsd: 1.3, wakes: 4 });
});

// ---- TextInput cursor clamp ----

test("clampCursor snaps a stranded cursor back onto a shrunken value (the post-send clear bug)", () => {
  expect(clampCursor(5, 0)).toBe(0); // draft "hello" cleared to "" -> cursor lands at 0, backspace works again
  expect(clampCursor(5, 3)).toBe(3); // value shrank to length 3 -> cursor clamps to the new end
});

test("clampCursor leaves an in-range cursor untouched (mid-string editing preserved)", () => {
  expect(clampCursor(2, 5)).toBe(2); // cursor already inside the value
  expect(clampCursor(5, 5)).toBe(5); // cursor at the end
  expect(clampCursor(0, 0)).toBe(0); // empty value, cursor at start
});

test("clampCursor never returns a negative cursor", () => {
  expect(clampCursor(-3, 5)).toBe(0);
});
