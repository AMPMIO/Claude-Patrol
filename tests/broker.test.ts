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

type StatsSeat = {
  seat_id: string;
  role: string | null;
  model: string | null;
  live: boolean;
  bound_via: string | null;
  notifications: number;
  messages: number;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  cost_usd: number;
};
type StatsBody = {
  seats: StatsSeat[];
  totals: { notifications: number; messages: number; cost_usd: number; unattributed_usd: number };
};

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
      CLAUDE_PATROL_TOKEN_SCAN_CAP: "3", // abandon a never-landing token scan after 3 misses (test the cap fast)
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

// --- v0.2 telemetry: /stats + delivery_log coalescing evidence ---

const SINCE_ALL = "2000-01-01T00:00:00Z";

test("delivery_log: one row per non-empty poll batch, batch_size = coalesced count (the coalescing evidence)", async () => {
  // An UNBOUND seat (no session_id) still surfaces in /stats via its run, with
  // bound_via null — the wake-up ledger doesn't need attribution.
  const reg = await post("/register", { pid: process.pid, cwd: "/tmp/deliv", git_root: null, tty: null, summary: "D", role: "recv", model: "sonnet" });
  const id = ((await reg.json()) as { id: string }).id;

  const meNow = async (): Promise<StatsSeat> => {
    const s = (await (await post("/stats", { since: SINCE_ALL })).json()) as StatsBody;
    return s.seats.find((x) => x.seat_id === id)!;
  };

  // 3 queued messages, ONE poll -> exactly one notification carrying all 3.
  for (const t of ["a", "b", "c"]) await post("/send-message", { from_id: "cli", to_id: id, text: t });
  await post("/poll-messages", { id });
  let me = await meNow();
  expect(me.notifications).toBe(1);
  expect(me.messages).toBe(3);
  expect(me.bound_via).toBeNull(); // unbound seat, still counted
  expect(me.live).toBe(true);

  // 2 more, a SECOND poll -> a second row (two distinct wake-ups).
  for (const t of ["d", "e"]) await post("/send-message", { from_id: "cli", to_id: id, text: t });
  await post("/poll-messages", { id });
  me = await meNow();
  expect(me.notifications).toBe(2);
  expect(me.messages).toBe(5);

  // Empty poll -> no notification fired -> no new row.
  await post("/poll-messages", { id });
  me = await meNow();
  expect(me.notifications).toBe(2);
  expect(me.messages).toBe(5);
});

test("/stats: token-bound seat reports bound_via=token and cost equal to /costs for the same window", async () => {
  const CWD = "/tmp/stats-token";
  const TOK = "cp-44440000";
  // opus 3000 in + 1000 out = (3000*5 + 1000*25)/1e6 = $0.04
  seatLog(CWD, "stats-sess-1", TOK, { i: 3000, o: 1000 });

  const reg = await post("/register", { pid: process.pid, cwd: CWD, git_root: null, tty: null, summary: "S", role: "worker", model: "opus", seat_token: TOK });
  const seatId = ((await reg.json()) as { id: string }).id;

  // wait for the Layer-1 token binding to land
  await pollCosts({ since: SINCE_ALL }, (c) => c.rows.some((r) => r.session_id === "stats-sess-1" && r.seat_id === seatId));

  const costs = (await (await post("/costs", { since: SINCE_ALL })).json()) as CostsBody;
  const stats = (await (await post("/stats", { since: SINCE_ALL })).json()) as StatsBody;

  const me = stats.seats.find((s) => s.seat_id === seatId)!;
  expect(me.bound_via).toBe("token"); // the attribution differentiator actually fired
  expect(me.model).toBe("opus");
  expect(me.cost_usd).toBeCloseTo(0.04, 4);

  // /stats and /costs cannot disagree: the seat's stats cost == the sum of its
  // /costs rows (same priced tallies, same seat resolution).
  const seatCostFromCosts = costs.rows.filter((r) => r.seat_id === seatId).reduce((a, r) => a + r.cost_usd, 0);
  expect(me.cost_usd).toBeCloseTo(seatCostFromCosts, 4);
});

test("/stats: unattributed_usd captures orphan spend; totals reconcile with /costs", async () => {
  const CWD = "/tmp/stats-orphan";
  const projDir = join(PROJECTS_ROOT, projectDirName(CWD));
  mkdirSync(projDir, { recursive: true });

  // A live seat in this dir bound (env) to a DIFFERENT session, so the dir is
  // indexed but the seat can't claim the orphan below.
  const holderReg = await post("/register", { pid: broker.pid, cwd: CWD, git_root: null, tty: null, summary: "holder", role: null, model: null, session_id: "orphan-holder" });
  const holderId = ((await holderReg.json()) as { id: string }).id;

  // Orphan spend: a session in the (now scanned) dir that no run owns.
  // opus 2000 in = 2000*5/1e6 = $0.01
  writeFileSync(
    join(projDir, "orphanS.jsonl"),
    JSON.stringify({ type: "assistant", sessionId: "orphanS", timestamp: new Date().toISOString(), message: { id: "o1", model: "claude-opus-4-8", usage: { input_tokens: 2000, output_tokens: 0 } } }) + "\n"
  );

  // wait until the orphan is visible in /costs as unattributed (seat_id null)
  const costs = await pollCosts({ since: SINCE_ALL }, (c) => c.rows.some((r) => r.session_id === "orphanS" && r.seat_id === null));
  const stats = (await (await post("/stats", { since: SINCE_ALL })).json()) as StatsBody;

  const attrFromCosts = costs.rows.filter((r) => r.seat_id !== null).reduce((a, r) => a + r.cost_usd, 0);
  const unattrFromCosts = costs.rows.filter((r) => r.seat_id === null).reduce((a, r) => a + r.cost_usd, 0);

  // register-time session_id fast path is labelled bound_via=env
  expect(stats.seats.find((s) => s.seat_id === holderId)!.bound_via).toBe("env");

  expect(stats.totals.unattributed_usd).toBeGreaterThan(0);
  expect(stats.totals.unattributed_usd).toBeCloseTo(unattrFromCosts, 3);
  expect(stats.totals.cost_usd).toBeCloseTo(attrFromCosts, 3);
  // The load-bearing invariant: /costs total == /stats attributed + unattributed.
  expect(stats.totals.cost_usd + stats.totals.unattributed_usd).toBeCloseTo(costs.total_usd, 3);
});

test("/stats is auth-gated and validates since", async () => {
  expect((await post("/stats", {}, "wrong")).status).toBe(401);
  expect((await post("/stats", { since: "not-a-date" })).status).toBe(400);
});

// --- v0.2 perf: bound the token re-scan for a marker that never lands ---

test("token scan is abandoned after the cap; the run stays bindable via observe", async () => {
  const CWD = "/tmp/abandon-tokenscan";
  const TOK = "cp-99990000"; // a launch marker that never reaches the log
  const projDir = join(PROJECTS_ROOT, projectDirName(CWD));
  mkdirSync(projDir, { recursive: true });
  // A decoy log WITHOUT the token: the dir is scannable but never matches.
  writeFileSync(
    join(projDir, "decoy.jsonl"),
    JSON.stringify({ type: "user", sessionId: "decoy", message: { role: "user", content: "no marker here" } }) + "\n"
  );

  const reg = await post("/register", { pid: process.pid, cwd: CWD, git_root: null, tty: null, summary: "silent", role: "worker", model: "opus", seat_token: TOK });
  const seatId = ((await reg.json()) as { id: string }).id;

  const meNow = async (): Promise<StatsSeat | undefined> => {
    const s = (await (await post("/stats", { since: SINCE_ALL })).json()) as StatsBody;
    return s.seats.find((x) => x.seat_id === seatId);
  };

  // Well past the cap (3 misses ≈ 240ms at an 80ms tick): the token scan gives up.
  await new Promise((r) => setTimeout(r, 700));
  // The marker lands NOW — but the scan is abandoned, so it must NOT rebind. A
  // still-live token scan would bind here; that it doesn't is the "stopped
  // re-scanning" proof.
  writeFileSync(
    join(projDir, `${TOK}-sess.jsonl`),
    JSON.stringify({ type: "user", sessionId: "late-sess", message: { role: "user", content: `late ${seatMarker(TOK)}` } }) + "\n"
  );
  await new Promise((r) => setTimeout(r, 400)); // ~5 more ticks with the marker present
  expect((await meNow())?.bound_via).toBeNull(); // abandoned: the late marker is ignored

  // Layer-2 observe can STILL bind the abandoned run. claude_pid 999999 owns no
  // seat, so observe falls to the unique-cwd path and binds THIS run.
  const obs = await post("/observe-session", { session_id: "observed-sess", transcript_path: "/tmp/t.jsonl", cwd: CWD, claude_pid: 999999 });
  expect(((await obs.json()) as { ok: boolean }).ok).toBe(true);

  let bound: StatsSeat | undefined;
  for (let i = 0; i < 40; i++) {
    bound = await meNow();
    if (bound?.bound_via) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(bound?.bound_via).toBe("observe"); // bound by observe, never by the abandoned token scan
});
