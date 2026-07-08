/**
 * Broker integration test: spins a real broker on an alternate port with a temp
 * DB + secret + a fixture projects tree, then exercises auth, registration
 * metadata (incl. profile), the sender-context join on poll, and the /costs
 * endpoint (attribution + subagents-aware totals wired through the broker).
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDirName, attributeSeatsToSessions } from "../src/costs.ts";
import { seatMarker } from "../shared/types.ts";

const PORT = 17900;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "patrol-broker-"));
const SECRET_FILE = join(dir, "secret");
const PROJECTS_ROOT = join(dir, "projects");

let broker: ReturnType<typeof Bun.spawn>;
let TOKEN: string;

async function post(path: string, body: unknown, token = TOKEN) {
  return fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-patrol-token": token },
    body: JSON.stringify(body),
  });
}

type CostsBody = { rows: Array<{ seat_id: string | null; session_id: string; input: number; output: number; cost_usd: number }>; total_usd: number };

// /costs is served from a ledger the broker fills on a background tick, so a
// just-written fixture appears within a tick or two — poll instead of racing it.
async function pollCosts(reqBody: unknown, until: (c: CostsBody) => boolean, tries = 60): Promise<CostsBody> {
  let last: CostsBody = { rows: [], total_usd: 0 };
  for (let i = 0; i < tries; i++) {
    last = (await (await post("/costs", reqBody)).json()) as CostsBody;
    if (until(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

beforeAll(async () => {
  // fixture projects tree: one opus session + one subagent transcript
  const projDir = join(PROJECTS_ROOT, "-tmp-projA", "sessA", "subagents");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(PROJECTS_ROOT, "-tmp-projA", "sessA.jsonl"),
    JSON.stringify({ type: "assistant", sessionId: "sessA", timestamp: "2026-07-08T10:00:00Z", message: { id: "m1", model: "claude-opus-4-8", usage: { input_tokens: 1000, output_tokens: 2000 } } }) + "\n"
  );
  writeFileSync(
    join(projDir, "agent-1.jsonl"),
    JSON.stringify({ type: "assistant", sessionId: "subX", timestamp: "2026-07-08T10:10:00Z", message: { id: "s1", model: "claude-sonnet-5", usage: { input_tokens: 4000, output_tokens: 1000 } } }) + "\n"
  );

  broker = Bun.spawn(["bun", new URL("../src/broker.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      CLAUDE_PATROL_PORT: String(PORT),
      CLAUDE_PATROL_DB: join(dir, "test.db"),
      CLAUDE_PATROL_SECRET_FILE: SECRET_FILE,
      CLAUDE_PATROL_PROJECTS_ROOT: PROJECTS_ROOT,
      CLAUDE_PATROL_INDEX_INTERVAL_MS: "80", // /costs reads a background ledger; keep ticks fast for tests
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${URL_BASE}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  TOKEN = (await Bun.file(SECRET_FILE).text()).trim();
});

afterAll(() => {
  broker.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("rejects requests without the shared secret", async () => {
  const res = await post("/list-seats", { scope: "machine", cwd: "/", git_root: null }, "wrong");
  expect(res.status).toBe(401);
});

test("register carries role/model/profile into list-seats", async () => {
  const res = await post("/register", {
    pid: process.pid,
    cwd: "/tmp/seat-a",
    git_root: null,
    tty: null,
    summary: "executor standing by",
    role: "executor",
    model: "opus",
    profile: "peer",
  });
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  expect(id).toHaveLength(8);

  const list = await post("/list-seats", { scope: "machine", cwd: "/", git_root: null });
  const seats = (await list.json()) as Array<{ id: string; role: string | null; model: string | null; profile: string | null }>;
  const me = seats.find((s) => s.id === id);
  expect(me?.role).toBe("executor");
  expect(me?.model).toBe("opus");
  expect(me?.profile).toBe("peer");
});

test("poll joins sender context onto messages", async () => {
  const reg = await post("/register", {
    pid: process.pid,
    cwd: "/tmp/orchestrator",
    git_root: null,
    tty: null,
    summary: "orchestrator summary",
    role: "orchestrator",
    model: "fable",
  });
  const sender = ((await reg.json()) as { id: string }).id;

  const sendRes = await post("/send-message", { from_id: sender, to_id: sender, text: "hello" });
  expect(((await sendRes.json()) as { ok: boolean }).ok).toBe(true);

  const poll = await post("/poll-messages", { id: sender });
  const { messages } = (await poll.json()) as {
    messages: Array<{ text: string; from_summary: string | null; from_role: string | null; from_model: string | null; delivered: boolean }>;
  };
  expect(messages).toHaveLength(1);
  expect(messages[0]!.text).toBe("hello");
  expect(messages[0]!.from_summary).toBe("orchestrator summary");
  expect(messages[0]!.from_role).toBe("orchestrator");
  expect(messages[0]!.from_model).toBe("fable");
  expect(messages[0]!.delivered).toBe(true);

  const again = await post("/poll-messages", { id: sender });
  expect(((await again.json()) as { messages: unknown[] }).messages).toHaveLength(0);
});

test("send to unknown seat fails cleanly", async () => {
  // malformed to_id is rejected at the validation layer (v0.2)...
  const malformed = await post("/send-message", { from_id: "cli", to_id: "nope", text: "x" });
  expect(malformed.status).toBe(400);
  // ...a well-formed slug that doesn't exist is an app-level {ok:false}
  const res = await post("/send-message", { from_id: "cli", to_id: "zzzzzzzz", text: "x" });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { ok: boolean; error?: string }).ok).toBe(false);
});

test("/costs is auth-gated and attributes via a registered session_id", async () => {
  expect((await post("/costs", {}, "wrong")).status).toBe(401);

  // register a seat in projA that owns session sessA -> exact attribution
  const reg = await post("/register", {
    pid: process.pid,
    cwd: "/tmp/projA",
    git_root: null,
    tty: null,
    summary: "cost seat",
    role: "worker",
    model: "opus",
    session_id: "sessA",
  });
  const seatId = ((await reg.json()) as { id: string }).id;

  const { rows, total_usd } = await pollCosts(
    { since: "2000-01-01T00:00:00Z" },
    (c) => c.rows.some((r) => r.session_id === "sessA")
  );
  // opus session 0.055 + sonnet subagent 0.027 = 0.082 (subagents counted)
  expect(total_usd).toBeCloseTo(0.082, 4);
  expect(rows.find((r) => r.session_id === "sessA")!.seat_id).toBe(seatId);
  // subX lives under sessA/subagents/ → rolls up to sessA's seat (v0.2)
  expect(rows.find((r) => r.session_id === "subX")!.seat_id).toBe(seatId);
});

test("unregister by pid deregisters the seat (SessionEnd hook path)", async () => {
  const reg = await post("/register", {
    pid: process.pid,
    cwd: "/tmp/ending",
    git_root: null,
    tty: null,
    summary: "about to end",
    role: null,
    model: null,
  });
  const id = ((await reg.json()) as { id: string }).id;

  const seatsBefore = (await (await post("/list-seats", { scope: "machine", cwd: "/", git_root: null })).json()) as Array<{ id: string }>;
  expect(seatsBefore.some((s) => s.id === id)).toBe(true);

  const u = await post("/unregister", { pid: process.pid });
  expect(((await u.json()) as { ok: boolean }).ok).toBe(true);

  const seatsAfter = (await (await post("/list-seats", { scope: "machine", cwd: "/", git_root: null })).json()) as Array<{ id: string }>;
  expect(seatsAfter.some((s) => s.id === id)).toBe(false);

  // idempotent: a second dereg (or one after stale cleanup) still returns ok
  expect(((await (await post("/unregister", { pid: process.pid })).json()) as { ok: boolean }).ok).toBe(true);
});

test("session_id uniqueness guard: a duplicate live claim is stored as null", async () => {
  // Seat A claims dupSess with a definitely-live pid (the broker subprocess).
  const regA = await post("/register", {
    pid: broker.pid, cwd: "/tmp/dup", git_root: null, tty: null,
    summary: "A", role: null, model: null, session_id: "dupSess",
  });
  const aResp = (await regA.json()) as { id: string; session_id_rejected?: boolean };
  expect(aResp.session_id_rejected).toBeUndefined(); // first claim wins
  const idA = aResp.id;

  // Seat B (different live pid) claims the same session_id -> rejected -> null.
  const regB = await post("/register", {
    pid: process.pid, cwd: "/tmp/dup", git_root: null, tty: null,
    summary: "B", role: null, model: null, session_id: "dupSess",
  });
  const bResp = (await regB.json()) as { id: string; session_id_rejected?: boolean };
  expect(bResp.session_id_rejected).toBe(true);
  const idB = bResp.id;

  const seats = (await (await post("/list-seats", { scope: "machine", cwd: "/", git_root: null })).json()) as Array<{ id: string; session_id: string | null }>;
  expect(seats.find((s) => s.id === idA)!.session_id).toBe("dupSess");
  expect(seats.find((s) => s.id === idB)!.session_id).toBeNull();
});

test("query-time attribution: a seat registered before its jsonl exists still attributes", async () => {
  // normal boot race: seat registers with NO session_id (log not written yet)
  const reg = await post("/register", {
    pid: process.pid,
    cwd: "/tmp/late",
    git_root: null,
    tty: null,
    summary: "late",
    role: null,
    model: null,
  });
  const id = ((await reg.json()) as { id: string }).id;

  // the session log appears AFTER registration; first record ts within 120s of registered_at
  const lateDir = join(PROJECTS_ROOT, "-tmp-late");
  mkdirSync(lateDir, { recursive: true });
  writeFileSync(
    join(lateDir, "sessLate.jsonl"),
    JSON.stringify({ type: "assistant", sessionId: "sessLate", timestamp: new Date().toISOString(), message: { id: "L1", model: "claude-opus-4-8", usage: { input_tokens: 1000, output_tokens: 1000 } } }) + "\n"
  );

  const { rows } = await pollCosts(
    { since: "2000-01-01T00:00:00Z" },
    (c) => c.rows.some((r) => r.session_id === "sessLate" && r.seat_id === id)
  );
  expect(rows.find((r) => r.session_id === "sessLate")!.seat_id).toBe(id);
});

// Helper: a project dir under PROJECTS_ROOT for a given cwd, with the session
// log carrying its seat marker + one assistant usage record.
function seatLog(cwd: string, sessionId: string, token: string, tokens: { i: number; o: number }, model = "claude-opus-4-8") {
  const projDir = join(PROJECTS_ROOT, projectDirName(cwd));
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(projDir, `${sessionId}.jsonl`),
    JSON.stringify({ type: "user", sessionId, message: { role: "user", content: `briefing ${seatMarker(token)}` } }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        sessionId,
        timestamp: new Date().toISOString(),
        message: { id: `${sessionId}-a1`, model, usage: { input_tokens: tokens.i, output_tokens: tokens.o } },
      }) +
      "\n"
  );
}

test("PROOF #2: two seats in one cwd, distinct tokens → each gets ITS spend (Layer 1; old heuristic can't)", async () => {
  const CWD = "/tmp/ms-samecwd";
  const T1 = "cp-11110000";
  const T2 = "cp-22220000";
  // two sessions in the SAME project dir, each log containing only its own token
  seatLog(CWD, "ms-sess-1", T1, { i: 1000, o: 0 }); // 1000 in * $5/MTok = $0.005
  seatLog(CWD, "ms-sess-2", T2, { i: 2000, o: 0 }); // 2000 in * $5/MTok = $0.010

  // The OLD attribution (Layer 3) collapses here: two same-cwd seats, no
  // session_id, both see BOTH logs → ambiguous → binds NEITHER. This is the
  // exact dark case v0.2 fixes; assert it fails so the proof is meaningful.
  const nowIso = new Date().toISOString();
  const oldMap = attributeSeatsToSessions({
    projectsRoot: PROJECTS_ROOT,
    seats: [
      { id: "sA", cwd: CWD, session_id: null, registered_at: nowIso },
      { id: "sB", cwd: CWD, session_id: null, registered_at: nowIso },
    ],
  });
  expect(oldMap.size).toBe(0); // old path attributes nothing

  // Register two seats (distinct live pids, distinct tokens), no session_id —
  // resolution must come from the token content match alone.
  const regA = await post("/register", { pid: process.pid, cwd: CWD, git_root: null, tty: null, summary: "A", role: null, model: null, seat_token: T1 });
  const seatA = ((await regA.json()) as { id: string }).id;
  const regB = await post("/register", { pid: broker.pid, cwd: CWD, git_root: null, tty: null, summary: "B", role: null, model: null, seat_token: T2 });
  const seatB = ((await regB.json()) as { id: string }).id;

  const { rows } = await pollCosts(
    { since: "2000-01-01T00:00:00Z" },
    (c) => {
      const r1 = c.rows.find((r) => r.session_id === "ms-sess-1");
      const r2 = c.rows.find((r) => r.session_id === "ms-sess-2");
      return !!r1 && !!r2 && r1.seat_id !== null && r2.seat_id !== null;
    }
  );
  const r1 = rows.find((r) => r.session_id === "ms-sess-1")!;
  const r2 = rows.find((r) => r.session_id === "ms-sess-2")!;
  expect(r1.seat_id).toBe(seatA); // seat A's token → sess-1, not swapped
  expect(r2.seat_id).toBe(seatB); // seat B's token → sess-2, not swapped
  expect(r1.cost_usd).toBeCloseTo(0.005, 4);
  expect(r2.cost_usd).toBeCloseTo(0.01, 4);
});

test("PROOF #3: a killed seat's spend still attributes via seat_runs.ended_at (history survives)", async () => {
  const CWD = "/tmp/ms-persist";
  const TOK = "cp-33330000";
  seatLog(CWD, "ms-persist-1", TOK, { i: 4000, o: 0 }); // $0.020

  const reg = await post("/register", { pid: broker.pid, cwd: CWD, git_root: null, tty: null, summary: "P", role: null, model: null, seat_token: TOK });
  const seatP = ((await reg.json()) as { id: string }).id;

  // wait for the token→session binding to land, THEN kill the seat
  await pollCosts({ since: "2000-01-01T00:00:00Z" }, (c) => c.rows.some((r) => r.session_id === "ms-persist-1" && r.seat_id === seatP));
  await post("/unregister", { id: seatP });

  // /costs with `since` BEFORE the seat ever registered still attributes it —
  // the binding lives in seat_runs (ended_at set), not the deleted live seat.
  const { rows } = await pollCosts(
    { since: "2000-01-01T00:00:00Z" },
    (c) => c.rows.some((r) => r.session_id === "ms-persist-1")
  );
  expect(rows.find((r) => r.session_id === "ms-persist-1")!.seat_id).toBe(seatP);
});

test("indexer incremental resume: appended records add once; a rewrite/truncate reparses", async () => {
  const CWD = "/tmp/ms-resume";
  const projDir = join(PROJECTS_ROOT, projectDirName(CWD));
  mkdirSync(projDir, { recursive: true });
  const file = join(projDir, "ms-resume-1.jsonl");
  const a = (id: string, i: number) =>
    JSON.stringify({ type: "assistant", sessionId: "ms-resume-1", timestamp: new Date().toISOString(), message: { id, model: "claude-opus-4-8", usage: { input_tokens: i, output_tokens: 0 } } }) + "\n";

  // register a seat here so the dir is indexed
  await post("/register", { pid: broker.pid, cwd: CWD, git_root: null, tty: null, summary: "R", role: null, model: null });

  writeFileSync(file, a("r1", 1000));
  const win = { since: "2000-01-01T00:00:00Z" };
  const sess = (c: CostsBody) => c.rows.find((r) => r.session_id === "ms-resume-1");
  let got = await pollCosts(win, (c) => (sess(c)?.cost_usd ?? 0) >= 0.005);
  expect(sess(got)!.input).toBe(1000);

  // append a NEW record → only the delta lands (no double count of r1)
  writeFileSync(file, a("r1", 1000) + a("r2", 500));
  got = await pollCosts(win, (c) => (sess(c)?.input ?? 0) === 1500);
  expect(sess(got)!.input).toBe(1500); // 1000 + 500, r1 not re-counted

  // rewrite smaller (truncate) → file's contribution is reset to the new content
  writeFileSync(file, a("r3", 200));
  got = await pollCosts(win, (c) => (sess(c)?.input ?? 0) === 200);
  expect(sess(got)!.input).toBe(200); // stale 1500 wiped, only r3 remains
});

// --- v0.2 security: validation layer + queue depth + identity partial ---

test("validation: oversized text is rejected 400", async () => {
  const reg = await post("/register", { pid: process.pid, cwd: "/tmp/val", git_root: null, tty: null, summary: "v", role: null, model: null });
  const id = ((await reg.json()) as { id: string }).id;
  const res = await post("/send-message", { from_id: "cli", to_id: id, text: "x".repeat(9000) });
  expect(res.status).toBe(400);
});

test("validation: malformed pid and wrong types are rejected 400", async () => {
  expect((await post("/register", { pid: -1, cwd: "/tmp/val", git_root: null, tty: null, summary: "" })).status).toBe(400);
  expect((await post("/register", { pid: "123", cwd: "/tmp/val", git_root: null, tty: null, summary: "" })).status).toBe(400);
  expect((await post("/register", { pid: process.pid, cwd: "", git_root: null, tty: null, summary: "" })).status).toBe(400);
  expect((await post("/register", { pid: process.pid, cwd: "/tmp/val", git_root: null, tty: null, summary: "s".repeat(501) })).status).toBe(400);
  expect((await post("/register", { pid: process.pid, cwd: "/tmp/val", git_root: null, tty: null, summary: "", seat_token: "not-a-token" })).status).toBe(400);
  expect((await post("/heartbeat", { id: "../../x" })).status).toBe(400);
  expect((await post("/unregister", { id: "aaaaaaaa", pid: 42 })).status).toBe(400); // exactly one
  expect((await post("/unregister", {})).status).toBe(400);
  expect((await post("/costs", { since: "not-a-date" })).status).toBe(400);
});

test("validation: from_id that is not a live seat (or cli) is rejected", async () => {
  const reg = await post("/register", { pid: process.pid, cwd: "/tmp/val2", git_root: null, tty: null, summary: "v2", role: null, model: null });
  const id = ((await reg.json()) as { id: string }).id;
  // well-formed slug, but nothing registered under it -> forged provenance
  const res = await post("/send-message", { from_id: "deadbeef", to_id: id, text: "hi" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; error?: string };
  expect(body.ok).toBe(false);
  expect(body.error).toContain("not a live seat");
});

test("queue-depth cap: /send-message returns 429 once the target backlog hits the cap", async () => {
  const reg = await post("/register", { pid: process.pid, cwd: "/tmp/val3", git_root: null, tty: null, summary: "v3", role: null, model: null });
  const id = ((await reg.json()) as { id: string }).id;
  for (let i = 0; i < 100; i++) {
    const r = await post("/send-message", { from_id: "cli", to_id: id, text: `m${i}` });
    expect(r.status).toBe(200);
  }
  const over = await post("/send-message", { from_id: "cli", to_id: id, text: "overflow" });
  expect(over.status).toBe(429);
  // draining the queue frees it again
  await post("/poll-messages", { id });
  const after = await post("/send-message", { from_id: "cli", to_id: id, text: "ok again" });
  expect(after.status).toBe(200);
});
