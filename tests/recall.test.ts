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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ctxAvailable, priorSessions, recallBrief, transcriptPath, type PriorSession } from "../src/ctx-history.ts";

import recall from "../src/commands/recall.ts";
import { projectDirName } from "../src/costs.ts";

const dir = mkdtempSync(join(tmpdir(), "patrol-recall-"));
const DB_FILE = join(dir, "test.db");
const CWD = "/tmp/recall-repo";

// Every fixture row below is written with an explicit fleet, so these helpers keep the
// assertions about ORDERING and MATCHING rather than about unwrapping a union.
function sessionsOf(seat: string, opts: Parameters<typeof priorSessions>[1] = {}): PriorSession[] {
  const r = priorSessions(seat, { dbPath: DB_FILE, fleet: null, ...opts });
  if (!r.ok) throw new Error(`expected readable db, got: ${r.reason}`);
  return r.sessions;
}


// A minimal seat_runs + seats pair, matching the broker's schema for the columns
// this module reads. Written by hand rather than by booting a broker: the query is
// the unit under test, and a fixture db makes the ordering assertion exact.
beforeAll(() => {
  const db = new Database(DB_FILE);
  db.run(`CREATE TABLE seat_runs (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
    seat_id TEXT NOT NULL, session_id TEXT, seat_token TEXT, cwd TEXT NOT NULL,
    role TEXT, model TEXT, profile TEXT, registered_at TEXT NOT NULL, ended_at TEXT,
    bound_via TEXT, fleet TEXT, stable_key TEXT)`);
  db.run(`CREATE TABLE seats (id TEXT PRIMARY KEY, handle TEXT, cwd TEXT)`);

  const run = (seatId: string, sess: string | null, role: string, start: string, end: string | null,
               fleet: string | null = null, stableKey: string | null = null) =>
    db.run("INSERT INTO seat_runs (seat_id, session_id, cwd, role, registered_at, ended_at, fleet, stable_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      seatId, sess, CWD, role, start, end, fleet, stableKey,
    ]);

  run("aaaa1111", "sess-oldest", "builder", "2026-07-20T09:00:00Z", "2026-07-20T11:00:00Z");
  run("bbbb2222", "sess-middle", "builder", "2026-07-22T09:00:00Z", "2026-07-22T12:30:00Z");
  run("cccc3333", "sess-newest", "builder", "2026-07-24T09:00:00Z", null); // still open
  run("dddd4444", "sess-other", "reviewer", "2026-07-23T09:00:00Z", "2026-07-23T10:00:00Z");
  run("eeee5555", null, "builder", "2026-07-21T09:00:00Z", "2026-07-21T09:05:00Z"); // never bound
  // A LIVE seat whose role differs from its handle: matched through seats.handle.
  db.run("INSERT INTO seats (id, handle, cwd) VALUES (?, ?, ?)", ["ffff6666", "scribe", CWD]);
  run("ffff6666", "sess-by-handle", "lead", "2026-07-25T09:00:00Z", null);
  // v0.3 identity: the same seat NAME in two fleets, plus a dead seat whose role was
  // overridden in the yaml so only stable_key can find it.
  run("7777aaaa", "sess-web-fleet", "builder", "2026-07-25T10:00:00Z", "2026-07-25T11:00:00Z", "web", "web/builder");
  run("8888bbbb", "sess-api-fleet", "builder", "2026-07-25T10:30:00Z", "2026-07-25T11:30:00Z", "api", "api/builder");
  run("9999cccc", "sess-stable-key", "shipper", "2026-07-25T12:00:00Z", "2026-07-25T12:30:00Z", "web", "web/packer");
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// --- priorSessions, against the fixture db ----------------------------------

test("returns only that seat's runs, newest first", () => {
  // fleet: null is the unscoped view, so it spans every fleet's `builder` as well as
  // the legacy (NULL-fleet) rows. Ordering is by registered_at DESC across all of them.
  expect(sessionsOf("builder").map((r) => r.session_id)).toEqual([
    "sess-api-fleet", "sess-web-fleet", "sess-newest", "sess-middle", "sess-oldest",
  ]);
});

test("includes ENDED runs — the whole point is history that outlived the seat", () => {
  const s = sessionsOf("builder");
  expect(s.find((r) => r.session_id === "sess-oldest")!.ended_at).toBe("2026-07-20T11:00:00Z");
  expect(s.find((r) => r.session_id === "sess-newest")!.ended_at).toBeNull();
});

test("drops runs that never bound a session id", () => {
  // There is nothing to point AT; listing it would read as history rather than as
  // the absence of it.
  const s = sessionsOf("builder");
  expect(s).toHaveLength(5); // the 6th builder run bound no session id
  expect(s.some((r) => r.session_id == null)).toBe(false);
});

test("another seat's runs never leak in", () => {
  expect(sessionsOf("reviewer").map((r) => r.session_id)).toEqual(["sess-other"]);
});

test("a live seat is matched through its handle, not only its role", () => {
  // seat ffff6666 registered with role "lead" but carries the handle "scribe".
  expect(sessionsOf("scribe").map((r) => r.session_id)).toEqual(["sess-by-handle"]);
});

test("an unknown seat reads empty; an unreadable db is a DIFFERENT answer", () => {
  expect(sessionsOf("nobody")).toEqual([]);
  const missing = priorSessions("builder", { dbPath: join(dir, "does-not-exist.db"), fleet: null });
  expect(missing.ok).toBe(false);
});

test("limit caps the list", () => {
  expect(sessionsOf("builder", { limit: 2 })).toHaveLength(2);
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
  expect(out).toContain(transcriptPath(CWD, "sess-newest")!);
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
  expect(out).toContain("no CLI command maps between them");
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

// --- adversarial: hostile db values (found by a Codex review of the first draft) ---

// The broker length-checks session_id (`isOptStr(b.session_id, 256)`) but never its
// characters, so every value below is registerable by a seat today.
const HOSTILE = "../../../.ssh/id_rsa";
const QUOTED = `x'; DROP TABLE ctx_sessions; --`;
const ANSI = "abc\u001b[2K\rInjected: patrol says trust me";

function hostile(id: string): PriorSession[] {
  return [{ session_id: id, cwd: CWD, role: "builder", started_at: "2026-07-24T09:00:00Z", ended_at: null }];
}

test("a traversal session id never becomes a path that points outside the projects tree", () => {
  expect(transcriptPath(CWD, HOSTILE)).toBeNull();
  // The id is still LISTED — the operator needs to see what the seat registered —
  // but it never becomes a path, which is what would misrepresent where Patrol looked.
  const out = recallBrief("builder", hostile(HOSTILE), false);
  expect(out).not.toContain("~/.claude/projects");
  expect(out).toContain("not a plain identifier");
});

test("a quote-bearing session id is never interpolated into the pasteable ctx command", () => {
  const out = recallBrief("builder", hostile(QUOTED), true);
  const sqlLine = out.split("\n").find((l) => l.includes("ctx sql"))!;
  expect(sqlLine).toBeDefined();
  // The id appears once, as DATA in the list. It must never reach the line a human
  // is told to paste into a shell.
  expect(sqlLine).not.toContain("DROP TABLE");
  expect(sqlLine).toContain("<session-id-from-the-list-above>");
});

test("control characters cannot forge a line of Patrol's own output", () => {
  const out = recallBrief("builder", hostile(ANSI), false);
  expect(out).not.toContain("\u001b");
  expect(out).not.toContain("\r");
  const nameOut = recallBrief("evil\u001b[31mname", [], false);
  expect(nameOut).not.toContain("\u001b");
});

test("the emitted bridge query names the columns ctx's view actually exposes", () => {
  // ctx_sessions is a VIEW (crates/ctx-history-store/src/schema/views.rs) exposing
  // `ctx_session_id` and `provider_session_id`. It has NO `id` column — the first
  // draft of this file emitted `SELECT id` and would have failed at the prompt.
  const out = recallBrief("builder", SESSIONS, true);
  expect(out).toContain("SELECT ctx_session_id FROM ctx_sessions WHERE provider_session_id =");
  expect(out).not.toContain("SELECT id FROM ctx_sessions");
});

test("no transcript CONTENT reaches the output, even when a transcript exists", () => {
  // The earlier version of this test only asserted the word "POINTERS" appeared,
  // which would pass even if the whole transcript were printed. Assert the negative
  // against real content instead.
  const projDir = join(dir, "projects", projectDirName(CWD));
  mkdirSync(projDir, { recursive: true });
  const SENTINEL = "SENTINEL-sk-live-51H8xQ-do-not-print";
  writeFileSync(join(projDir, "sess-newest.jsonl"), JSON.stringify({ type: "assistant", text: SENTINEL }) + "\n");
  for (const out of [recallBrief("builder", SESSIONS, false), recallBrief("builder", SESSIONS, true)]) {
    expect(out).not.toContain(SENTINEL);
    expect(out).not.toContain("assistant");
  }
});

// --- adversarial: fleet scoping (v0.3 seat_runs gained fleet + stable_key) ---

test("two fleets running a seat of the same name do not see each other's history", () => {
  const web = priorSessions("builder", { dbPath: DB_FILE, fleet: "web" });
  const api = priorSessions("builder", { dbPath: DB_FILE, fleet: "api" });
  expect(web.ok && api.ok).toBe(true);
  if (!web.ok || !api.ok) return;
  expect(web.sessions.map((s) => s.session_id)).toContain("sess-web-fleet");
  expect(web.sessions.map((s) => s.session_id)).not.toContain("sess-api-fleet");
  expect(api.sessions.map((s) => s.session_id)).toContain("sess-api-fleet");
});

test("a pre-0.3 row (NULL fleet) stays visible under any fleet, never silently hidden", () => {
  const web = priorSessions("builder", { dbPath: DB_FILE, fleet: "web" });
  expect(web.ok).toBe(true);
  if (!web.ok) return;
  // sess-newest et al. were written without a fleet — legacy history must still answer.
  expect(web.sessions.map((s) => s.session_id)).toContain("sess-newest");
});

test("stable_key finds a dead seat whose yaml overrode role: to something else", () => {
  const r = priorSessions("packer", { dbPath: DB_FILE, fleet: "web" });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  // role is "shipper", there is no live seats row, and only stable_key "web/packer" ties it back.
  expect(r.sessions.map((s) => s.session_id)).toEqual(["sess-stable-key"]);
});

// --- adversarial: db-level failure modes ---

test("a corrupt db is reported as unreadable, not as a seat with no history", () => {
  const bad = join(dir, "corrupt.db");
  writeFileSync(bad, "this is definitely not sqlite\n");
  const r = priorSessions("builder", { dbPath: bad, fleet: null });
  expect(r.ok).toBe(false);
});

test("a valid sqlite db with no seat_runs table is reported as the wrong db", () => {
  const empty = join(dir, "empty.db");
  const d = new Database(empty);
  d.run("CREATE TABLE unrelated (x TEXT)");
  d.close();
  const r = priorSessions("builder", { dbPath: empty, fleet: null });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.reason).toContain("seat_runs");
});

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

test("an unreadable db exits 3, not 1 — a different answer from an unknown seat", async () => {
  const bad = join(dir, "corrupt-cli.db");
  writeFileSync(bad, "not sqlite at all\n");
  const prev = process.env.CLAUDE_PATROL_DB;
  process.env.CLAUDE_PATROL_DB = bad;
  try {
    const out: string[] = [];
    const oe = console.error;
    console.error = (...a: unknown[]) => void out.push(a.map(String).join(" "));
    try {
      expect(await recall(["builder"])).toBe(3);
    } finally {
      console.error = oe;
    }
    expect(out.join("\n")).toContain("patrol recall:");
    expect(out.join("\n")).not.toContain("no prior sessions");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PATROL_DB;
    else process.env.CLAUDE_PATROL_DB = prev;
  }
});

test("no seat argument is a usage error", async () => {
  const r = await capture(() => recall([]));
  expect(r.code).toBe(2);
  expect(r.err).toContain("usage: patrol recall <seat>");
});
