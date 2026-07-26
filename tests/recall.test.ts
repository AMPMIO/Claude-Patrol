/**
 * patrol recall — the seat -> prior-session mapping.
 *
 * The ctx-ABSENT path is the default here, deliberately: ctx is an optional
 * dependency and is not installed on the machine this was written on, so the
 * degraded path is the one that must be provably good. The ctx-present brief is
 * tested by passing the flag directly to the pure function — never by probing PATH,
 * which would make the suite depend on what happens to be installed.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ctxAvailable, priorSessions, recallBrief, transcriptPath, type PriorSession } from "../src/ctx-history.ts";
import recall from "../src/commands/recall.ts";

const dir = mkdtempSync(join(tmpdir(), "patrol-recall-"));
const DB_FILE = join(dir, "test.db");
const CWD = "/tmp/recall-repo";

// A minimal seat_runs + seats pair, matching the broker's schema for the columns
// this module reads. Written by hand rather than by booting a broker: the query is
// the unit under test, and a fixture db makes the ordering assertion exact.
beforeAll(() => {
  const db = new Database(DB_FILE);
  db.run(`CREATE TABLE seat_runs (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
    seat_id TEXT NOT NULL, session_id TEXT, seat_token TEXT, cwd TEXT NOT NULL,
    role TEXT, model TEXT, profile TEXT, registered_at TEXT NOT NULL, ended_at TEXT)`);
  db.run(`CREATE TABLE seats (id TEXT PRIMARY KEY, handle TEXT, cwd TEXT)`);

  const run = (seatId: string, sess: string | null, role: string, start: string, end: string | null) =>
    db.run("INSERT INTO seat_runs (seat_id, session_id, cwd, role, registered_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)", [
      seatId, sess, CWD, role, start, end,
    ]);

  run("aaaa1111", "sess-oldest", "builder", "2026-07-20T09:00:00Z", "2026-07-20T11:00:00Z");
  run("bbbb2222", "sess-middle", "builder", "2026-07-22T09:00:00Z", "2026-07-22T12:30:00Z");
  run("cccc3333", "sess-newest", "builder", "2026-07-24T09:00:00Z", null); // still open
  run("dddd4444", "sess-other", "reviewer", "2026-07-23T09:00:00Z", "2026-07-23T10:00:00Z");
  run("eeee5555", null, "builder", "2026-07-21T09:00:00Z", "2026-07-21T09:05:00Z"); // never bound
  // A LIVE seat whose role differs from its handle: matched through seats.handle.
  db.run("INSERT INTO seats (id, handle, cwd) VALUES (?, ?, ?)", ["ffff6666", "scribe", CWD]);
  run("ffff6666", "sess-by-handle", "lead", "2026-07-25T09:00:00Z", null);
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// --- priorSessions, against the fixture db ----------------------------------

test("returns only that seat's runs, newest first", () => {
  const s = priorSessions("builder", { dbPath: DB_FILE });
  expect(s.map((r) => r.session_id)).toEqual(["sess-newest", "sess-middle", "sess-oldest"]);
});

test("includes ENDED runs — the whole point is history that outlived the seat", () => {
  const s = priorSessions("builder", { dbPath: DB_FILE });
  expect(s.find((r) => r.session_id === "sess-oldest")!.ended_at).toBe("2026-07-20T11:00:00Z");
  expect(s.find((r) => r.session_id === "sess-newest")!.ended_at).toBeNull();
});

test("drops runs that never bound a session id", () => {
  // There is nothing to point AT; listing it would read as history rather than as
  // the absence of it.
  const s = priorSessions("builder", { dbPath: DB_FILE });
  expect(s).toHaveLength(3);
  expect(s.some((r) => r.session_id == null)).toBe(false);
});

test("another seat's runs never leak in", () => {
  expect(priorSessions("reviewer", { dbPath: DB_FILE }).map((r) => r.session_id)).toEqual(["sess-other"]);
});

test("a live seat is matched through its handle, not only its role", () => {
  // seat ffff6666 registered with role "lead" but carries the handle "scribe".
  expect(priorSessions("scribe", { dbPath: DB_FILE }).map((r) => r.session_id)).toEqual(["sess-by-handle"]);
});

test("an unknown seat and a missing db both degrade to empty, never throw", () => {
  expect(priorSessions("nobody", { dbPath: DB_FILE })).toEqual([]);
  expect(priorSessions("builder", { dbPath: join(dir, "does-not-exist.db") })).toEqual([]);
});

test("limit caps the list", () => {
  expect(priorSessions("builder", { dbPath: DB_FILE, limit: 2 })).toHaveLength(2);
});

// --- recallBrief, pure ------------------------------------------------------

const SESSIONS: PriorSession[] = [
  { session_id: "sess-newest", cwd: CWD, role: "builder", started_at: "2026-07-24T09:00:00Z", ended_at: null },
  { session_id: "sess-middle", cwd: CWD, role: "builder", started_at: "2026-07-22T09:00:00Z", ended_at: "2026-07-22T12:30:00Z" },
];

test("zero prior sessions says so plainly instead of printing an empty list", () => {
  const out = recallBrief("builder", [], false);
  expect(out).toContain("no prior sessions");
  expect(out).toContain("Nothing to recall");
  expect(out).not.toContain("1.");
});

test("without ctx: ids, time bounds, transcript paths, and the install pointer", () => {
  const out = recallBrief("builder", SESSIONS, false);
  expect(out).toContain("2 prior sessions");
  expect(out).toContain("sess-newest");
  expect(out).toContain("still open"); // a run with no ended_at
  expect(out).toContain("2026-07-22T12:30:00Z");
  expect(out).toContain(transcriptPath(CWD, "sess-newest"));
  expect(out).toContain("github.com/ctxrs/ctx");
  // No ctx invocation may appear when ctx is absent.
  expect(out).not.toContain("ctx show session");
  expect(out).not.toContain("ctx sql");
});

test("with ctx: only commands that are actually documented", () => {
  const out = recallBrief("builder", SESSIONS, true);
  expect(out).toContain("ctx sql");
  expect(out).toContain("ctx show session <ctx-session-id>");
  expect(out).toContain("ctx locate session <ctx-session-id>");
  expect(out).toContain("ctx search");
  // The load-bearing honesty: ctx addresses sessions by its OWN id, so the provider
  // id must NEVER be printed as an argument to show/locate. That command would look
  // right and fail.
  expect(out).not.toContain("ctx show session sess-newest");
  expect(out).not.toContain("ctx locate session sess-newest");
  expect(out).toContain("no documented");
});

test("both modes state that these are pointers, and neither prints content", () => {
  for (const out of [recallBrief("builder", SESSIONS, false), recallBrief("builder", SESSIONS, true)]) {
    expect(out).toContain("POINTERS");
    expect(out).toContain("reads as instructions");
  }
});

test("singular/plural reads correctly for one session", () => {
  expect(recallBrief("builder", [SESSIONS[0]!], false)).toContain("1 prior session,");
});

test("ctxAvailable is a probe, not a requirement", () => {
  // Whatever this machine has, the call must answer a boolean rather than throw —
  // that is the entire contract, and asserting WHICH boolean would make the suite
  // depend on what happens to be installed.
  expect(typeof ctxAvailable()).toBe("boolean");
});

// --- the command ------------------------------------------------------------

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
  const prevDb = process.env.CLAUDE_PATROL_DB;
  process.env.CLAUDE_PATROL_DB = DB_FILE;
  try {
    return { code: await fn(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = ol;
    console.error = oe;
    if (prevDb === undefined) delete process.env.CLAUDE_PATROL_DB;
    else process.env.CLAUDE_PATROL_DB = prevDb;
  }
}

test("patrol recall <seat> prints the brief and exits 0", async () => {
  const r = await capture(() => recall(["builder"]));
  expect(r.code).toBe(0);
  expect(r.out).toContain("sess-newest");
});

test("an unknown seat exits nonzero with the reason on stderr", async () => {
  const r = await capture(() => recall(["ghost"]));
  expect(r.code).toBe(1);
  expect(r.err).toContain("no prior sessions");
  expect(r.out).toBe("");
});

test("no seat argument is a usage error", async () => {
  const r = await capture(() => recall([]));
  expect(r.code).toBe(2);
  expect(r.err).toContain("usage: patrol recall <seat>");
});
