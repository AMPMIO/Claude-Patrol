/**
 * Broker integration test: spins a real broker on an alternate port with a temp
 * DB + secret + a fixture projects tree, then exercises auth, registration
 * metadata (incl. profile), the sender-context join on poll, and the /costs
 * endpoint (attribution + subagents-aware totals wired through the broker).
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDirName, attributeSeatsToSessions } from "../src/costs.ts";
import { seatMarker } from "../shared/types.ts";

const PORT = 17900;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "patrol-broker-"));
const SECRET_FILE = join(dir, "secret");
const DB_FILE = join(dir, "test.db");
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
      CLAUDE_PATROL_DB: DB_FILE,
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
  // v0.2.3: a poll LEASES, it does not deliver. delivered flips only on /ack.
  expect(messages[0]!.delivered).toBe(false);

  // The lease is held, so an immediate re-poll returns nothing (no double-delivery to a
  // live consumer) even though the message is still undelivered.
  const again = await post("/poll-messages", { id: sender });
  expect(((await again.json()) as { messages: unknown[] }).messages).toHaveLength(0);

  // Ack settles it, and it stays gone.
  const ids = (messages as unknown as Array<{ id: number }>).map((m) => m.id);
  expect((await post("/ack", { id: sender, message_ids: ids })).status).toBe(200);
  const afterAck = await post("/poll-messages", { id: sender });
  expect(((await afterAck.json()) as { messages: unknown[] }).messages).toHaveLength(0);
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
  // v0.2.3: a poll only LEASES, so it does NOT free the queue — a leased-but-unacked
  // message is still unsettled and still counts against the cap. That is the point: the
  // backlog is not "drained" until the consumer confirms the messages are out.
  const leased = await post("/poll-messages", { id });
  const leasedIds = ((await leased.json()) as { messages: Array<{ id: number }> }).messages.map((m) => m.id);
  const stillFull = await post("/send-message", { from_id: "cli", to_id: id, text: "still full" });
  expect(stillFull.status).toBe(429);

  // Acking the batch is what actually drains it.
  expect((await post("/ack", { id, message_ids: leasedIds })).status).toBe(200);
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

// --- v0.2.1 fixes: observe invariants (A1), stale-seat unification (A2),
// ledger in-place rewrites (A3), /log message history (B) ---

// Read-only peek at the broker's live DB (a second WAL connection; SELECTs only).
function peekDb<T>(fn: (db: Database) => T): T {
  const db = new Database(DB_FILE);
  db.run("PRAGMA busy_timeout = 3000");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// A1: /observe-session binding invariants (never-misattribute).

test("A1: observe rejects a session_id another run already owns", async () => {
  // run A owns "obs-dup" via the register-time env fast path
  await post("/register", { pid: process.pid, cwd: "/tmp/obs-dup-a", git_root: null, tty: null, summary: "A", role: null, model: null, session_id: "obs-dup" });
  // run B (a different live pid, no session) posts observe claiming the SAME session
  const regB = await post("/register", { pid: broker.pid, cwd: "/tmp/obs-dup-b", git_root: null, tty: null, summary: "B", role: null, model: null });
  const idB = ((await regB.json()) as { id: string }).id;

  const obs = await post("/observe-session", { session_id: "obs-dup", transcript_path: "/tmp/t.jsonl", cwd: "/tmp/obs-dup-b", claude_pid: broker.pid });
  expect(((await obs.json()) as { ok: boolean }).ok).toBe(false);

  const runB = peekDb((db) => db.query("SELECT session_id, bound_via FROM seat_runs WHERE seat_id = ?").get(idB)) as { session_id: string | null; bound_via: string | null };
  expect(runB.session_id).toBeNull(); // B stays unbound
  expect(runB.bound_via).toBeNull();
  const owners = peekDb((db) => db.query("SELECT COUNT(*) AS c FROM seat_runs WHERE session_id = ?").get("obs-dup")) as { c: number };
  expect(owners.c).toBe(1); // only A owns it
});

test("A1: observe cannot overwrite a token-bound run", async () => {
  const CWD = "/tmp/obs-tokenbound";
  const TOK = "cp-55550000";
  seatLog(CWD, "obs-tok-sess", TOK, { i: 1000, o: 0 }); // $0.005

  const reg = await post("/register", { pid: process.pid, cwd: CWD, git_root: null, tty: null, summary: "T", role: "worker", model: "opus", seat_token: TOK });
  const seatId = ((await reg.json()) as { id: string }).id;

  // wait for the Layer-1 token binding to land
  await pollCosts({ since: SINCE_ALL }, (c) => c.rows.some((r) => r.session_id === "obs-tok-sess" && r.seat_id === seatId));

  // observe posts a DIFFERENT session for the SAME claude pid -> refused, no overwrite
  const obs = await post("/observe-session", { session_id: "obs-tok-OTHER", transcript_path: "/tmp/t.jsonl", cwd: CWD, claude_pid: process.pid });
  expect(((await obs.json()) as { ok: boolean }).ok).toBe(false);

  const stats = (await (await post("/stats", { since: SINCE_ALL })).json()) as StatsBody;
  expect(stats.seats.find((s) => s.seat_id === seatId)!.bound_via).toBe("token"); // unchanged
  const costs = (await (await post("/costs", { since: SINCE_ALL })).json()) as CostsBody;
  expect(costs.rows.find((r) => r.session_id === "obs-tok-sess")!.seat_id).toBe(seatId); // still attributes the original
});

test("A1: observe with a non-matching pid binds neither of two unbound same-cwd runs", async () => {
  const CWD = "/tmp/obs-neither";
  const reg1 = await post("/register", { pid: process.pid, cwd: CWD, git_root: null, tty: null, summary: "n1", role: null, model: null });
  const id1 = ((await reg1.json()) as { id: string }).id;
  const reg2 = await post("/register", { pid: broker.pid, cwd: CWD, git_root: null, tty: null, summary: "n2", role: null, model: null });
  const id2 = ((await reg2.json()) as { id: string }).id;

  const obs = await post("/observe-session", { session_id: "obs-neither-sess", transcript_path: "/tmp/t.jsonl", cwd: CWD, claude_pid: 999999 });
  expect(((await obs.json()) as { ok: boolean }).ok).toBe(false);

  const runs = peekDb((db) => db.query("SELECT session_id, bound_via FROM seat_runs WHERE seat_id IN (?, ?)").all(id1, id2)) as { session_id: string | null; bound_via: string | null }[];
  expect(runs).toHaveLength(2);
  expect(runs.every((r) => r.session_id === null && r.bound_via === null)).toBe(true); // neither bound
});

test("A1: observe is idempotent — a same-value re-post changes nothing", async () => {
  const CWD = "/tmp/obs-idem";
  const reg = await post("/register", { pid: process.pid, cwd: CWD, git_root: null, tty: null, summary: "I", role: null, model: null });
  const id = ((await reg.json()) as { id: string }).id;

  const first = await post("/observe-session", { session_id: "obs-idem-sess", transcript_path: "/tmp/t.jsonl", cwd: CWD, claude_pid: process.pid });
  expect(((await first.json()) as { ok: boolean }).ok).toBe(true);
  const before = peekDb((db) => db.query("SELECT session_id, bound_via FROM seat_runs WHERE seat_id = ?").get(id)) as { session_id: string | null; bound_via: string | null };
  expect(before.session_id).toBe("obs-idem-sess");
  expect(before.bound_via).toBe("observe");

  const again = await post("/observe-session", { session_id: "obs-idem-sess", transcript_path: "/tmp/t.jsonl", cwd: CWD, claude_pid: process.pid });
  expect(((await again.json()) as { ok: boolean }).ok).toBe(true); // idempotent ok
  const after = peekDb((db) => db.query("SELECT session_id, bound_via FROM seat_runs WHERE seat_id = ?").get(id)) as { session_id: string | null; bound_via: string | null };
  expect(after).toEqual(before); // unchanged
});

// A1 (round 2): an ENDED run's session is fair game to re-bind. A restarted seat
// resuming the same CC session must claim it, not stay dark because the dead
// seat's run still names the session id. Only OPEN runs enforce uniqueness.

test("A1: observe rebinds a session whose prior owner run has ended (resume)", async () => {
  const S = "obs-resume-sess";
  // run A owns S via the env fast path, then unregisters — its run ends but keeps S
  const regA = await post("/register", { pid: process.pid, cwd: "/tmp/obs-resume-a", git_root: null, tty: null, summary: "A", role: null, model: null, session_id: S });
  const idA = ((await regA.json()) as { id: string }).id;
  await post("/unregister", { id: idA });
  const runA = peekDb((db) => db.query("SELECT session_id, ended_at FROM seat_runs WHERE seat_id = ?").get(idA)) as { session_id: string | null; ended_at: string | null };
  expect(runA.session_id).toBe(S);
  expect(runA.ended_at).not.toBeNull(); // A's run ended but still names S

  // run B (live, distinct pid) resumes the SAME CC session and observes it
  const regB = await post("/register", { pid: broker.pid, cwd: "/tmp/obs-resume-b", git_root: null, tty: null, summary: "B", role: null, model: null });
  const idB = ((await regB.json()) as { id: string }).id;
  const obs = await post("/observe-session", { session_id: S, transcript_path: "/tmp/t.jsonl", cwd: "/tmp/obs-resume-b", claude_pid: broker.pid });
  expect(((await obs.json()) as { ok: boolean }).ok).toBe(true); // the ended owner no longer blocks

  const runB = peekDb((db) => db.query("SELECT session_id, bound_via FROM seat_runs WHERE seat_id = ?").get(idB)) as { session_id: string | null; bound_via: string | null };
  expect(runB.session_id).toBe(S);
  expect(runB.bound_via).toBe("observe");
});

test("A1: token resolution rebinds a session whose prior owner run has ended (resume)", async () => {
  const CWD = "/tmp/tok-resume";
  const TOK = "cp-77770000";
  const S = "tok-resume-sess";
  seatLog(CWD, S, TOK, { i: 1000, o: 0 });

  // seat A binds S via Layer-1 token match, then unregisters (run ends, keeps S)
  const regA = await post("/register", { pid: process.pid, cwd: CWD, git_root: null, tty: null, summary: "A", role: null, model: null, seat_token: TOK });
  const idA = ((await regA.json()) as { id: string }).id;
  await pollCosts({ since: SINCE_ALL }, (c) => c.rows.some((r) => r.session_id === S && r.seat_id === idA));
  await post("/unregister", { id: idA });

  // seat B (live, distinct pid) resumes the same CC session with the same token
  const regB = await post("/register", { pid: broker.pid, cwd: CWD, git_root: null, tty: null, summary: "B", role: null, model: null, seat_token: TOK });
  const idB = ((await regB.json()) as { id: string }).id;

  // the resolver rebinds S to B (A's run ended, no longer an OPEN owner);
  // readLedgerWindow's last-run-wins then attributes S's spend to B
  const { rows } = await pollCosts({ since: SINCE_ALL }, (c) => c.rows.some((r) => r.session_id === S && r.seat_id === idB));
  expect(rows.find((r) => r.session_id === S)!.seat_id).toBe(idB);
  const runB = peekDb((db) => db.query("SELECT session_id, bound_via FROM seat_runs WHERE seat_id = ?").get(idB)) as { session_id: string | null; bound_via: string | null };
  expect(runB.session_id).toBe(S);
  expect(runB.bound_via).toBe("token");
});

test("A1: two OPEN runs racing one session still conflict — exactly one binds (invariant intact)", async () => {
  const CWD = "/tmp/tok-conflict";
  const TOK = "cp-88880000";
  const S = "tok-conflict-sess";
  seatLog(CWD, S, TOK, { i: 1000, o: 0 });

  // two LIVE seats share a token + cwd -> both resolve to S. The first to bind
  // owns it; the second sees an OPEN owner and is left unbound (no double-attribute).
  const regA = await post("/register", { pid: process.pid, cwd: CWD, git_root: null, tty: null, summary: "A", role: null, model: null, seat_token: TOK });
  const idA = ((await regA.json()) as { id: string }).id;
  const regB = await post("/register", { pid: broker.pid, cwd: CWD, git_root: null, tty: null, summary: "B", role: null, model: null, seat_token: TOK });
  const idB = ((await regB.json()) as { id: string }).id;

  await pollCosts({ since: SINCE_ALL }, (c) => c.rows.some((r) => r.session_id === S && r.seat_id !== null));
  const runs = peekDb((db) => db.query("SELECT seat_id, session_id FROM seat_runs WHERE seat_id IN (?, ?)").all(idA, idB)) as { seat_id: string; session_id: string | null }[];
  expect(runs.filter((r) => r.session_id === S)).toHaveLength(1); // exactly one of the two open runs owns S
});

// A2: a dead seat swept via /list-seats is FULLY retired (run bounded + mail purged).

test("A2: /list-seats bounds the run and purges undelivered mail of a dead seat (before any sweep tick)", async () => {
  const DEAD_PID = 2_000_000_000; // valid pid int; no such live process
  const reg = await post("/register", { pid: DEAD_PID, cwd: "/tmp/deadseat", git_root: null, tty: null, summary: "dead", role: "worker", model: "opus" });
  const id = ((await reg.json()) as { id: string }).id;

  const send = await post("/send-message", { from_id: "cli", to_id: id, text: "unreachable" });
  expect(((await send.json()) as { ok: boolean }).ok).toBe(true);

  // BEFORE the sweep: run open, message queued
  const runBefore = peekDb((db) => db.query("SELECT ended_at FROM seat_runs WHERE seat_id = ?").get(id)) as { ended_at: string | null };
  expect(runBefore.ended_at).toBeNull();
  const queuedBefore = peekDb((db) => db.query("SELECT COUNT(*) AS c FROM messages WHERE to_id = ? AND delivered = 0").get(id)) as { c: number };
  expect(queuedBefore.c).toBe(1);

  // /list-seats is the ONLY sweep in-test (the 30s interval won't fire); it must
  // run the full endSeat path, not a bare row delete.
  await post("/list-seats", { scope: "machine", cwd: "/", git_root: null });

  const runAfter = peekDb((db) => db.query("SELECT ended_at FROM seat_runs WHERE seat_id = ?").get(id)) as { ended_at: string | null };
  expect(runAfter.ended_at).not.toBeNull(); // run bounded, no longer orphaned in stats windows
  const queuedAfter = peekDb((db) => db.query("SELECT COUNT(*) AS c FROM messages WHERE to_id = ? AND delivered = 0").get(id)) as { c: number };
  expect(queuedAfter.c).toBe(0); // undeliverable mail purged
  const rowAfter = peekDb((db) => db.query("SELECT id FROM seats WHERE id = ?").get(id));
  expect(rowAfter).toBeNull(); // live row gone
});

// A2 (round 2): re-registering the same pid is a FULL retirement of the replaced
// seat, not a bare row swap. A fresh id is issued, so mail still queued to the old
// seat_id can never be polled or swept — it must be purged and the run bounded.

test("A2: re-registering the same pid purges the replaced seat's mail and bounds its run", async () => {
  const PID = process.pid;
  const reg1 = await post("/register", { pid: PID, cwd: "/tmp/rereg", git_root: null, tty: null, summary: "one", role: null, model: null });
  const id1 = ((await reg1.json()) as { id: string }).id;

  const send = await post("/send-message", { from_id: "cli", to_id: id1, text: "orphan-me" });
  expect(((await send.json()) as { ok: boolean }).ok).toBe(true);
  const queuedBefore = peekDb((db) => db.query("SELECT COUNT(*) AS c FROM messages WHERE to_id = ? AND delivered = 0").get(id1)) as { c: number };
  expect(queuedBefore.c).toBe(1);

  // same pid re-registers -> a NEW seat id; the old one is fully retired
  const reg2 = await post("/register", { pid: PID, cwd: "/tmp/rereg", git_root: null, tty: null, summary: "two", role: null, model: null });
  const id2 = ((await reg2.json()) as { id: string }).id;
  expect(id2).not.toBe(id1);

  const queuedAfter = peekDb((db) => db.query("SELECT COUNT(*) AS c FROM messages WHERE to_id = ? AND delivered = 0").get(id1)) as { c: number };
  expect(queuedAfter.c).toBe(0); // orphaned mail purged, not left unpollable forever
  const run1 = peekDb((db) => db.query("SELECT ended_at FROM seat_runs WHERE seat_id = ?").get(id1)) as { ended_at: string | null };
  expect(run1.ended_at).not.toBeNull(); // replaced run bounded
  const row1 = peekDb((db) => db.query("SELECT id FROM seats WHERE id = ?").get(id1));
  expect(row1).toBeNull(); // old live row gone
});

// A3: the ledger indexer catches in-place rewrites, not just truncation/append.

const A3_WIN = { since: "2000-01-01T00:00:00Z" };

test("A3: a same-size in-place rewrite corrects the ledger totals (anchor hash)", async () => {
  const CWD = "/tmp/ms-samesize";
  const projDir = join(PROJECTS_ROOT, projectDirName(CWD));
  mkdirSync(projDir, { recursive: true });
  const file = join(projDir, "ms-samesize-1.jsonl");
  const TS = "2026-07-08T10:00:00.000Z";
  const rec = (i: number) =>
    JSON.stringify({ type: "assistant", sessionId: "ms-samesize-1", timestamp: TS, message: { id: "x1", model: "claude-opus-4-8", usage: { input_tokens: i, output_tokens: 0 } } }) + "\n";
  expect(Buffer.byteLength(rec(1000))).toBe(Buffer.byteLength(rec(2000))); // same-size precondition

  await post("/register", { pid: broker.pid, cwd: CWD, git_root: null, tty: null, summary: "SS", role: null, model: null });
  const sess = (c: CostsBody) => c.rows.find((r) => r.session_id === "ms-samesize-1");

  writeFileSync(file, rec(1000));
  let t = Math.floor(Date.now() / 1000) - 30;
  utimesSync(file, t, t);
  let got = await pollCosts(A3_WIN, (c) => (sess(c)?.input ?? 0) === 1000);
  expect(sess(got)!.input).toBe(1000);

  // rewrite in place: 1000 -> 2000, identical byte length, newer mtime. A cursor
  // parked at EOF would parse 0 new bytes and leave the ledger at 1000 forever.
  writeFileSync(file, rec(2000));
  t += 10;
  utimesSync(file, t, t);
  got = await pollCosts(A3_WIN, (c) => (sess(c)?.input ?? 0) === 2000);
  expect(sess(got)!.input).toBe(2000); // corrected, not stuck at 1000, not summed to 3000
});

test("A3: a rewrite-then-grow corrects the ledger (a stale byte cursor is not trusted)", async () => {
  const CWD = "/tmp/ms-regrow";
  const projDir = join(PROJECTS_ROOT, projectDirName(CWD));
  mkdirSync(projDir, { recursive: true });
  const file = join(projDir, "ms-regrow-1.jsonl");
  const TS = "2026-07-08T10:00:00.000Z";
  const rec = (id: string, i: number) =>
    JSON.stringify({ type: "assistant", sessionId: "ms-regrow-1", timestamp: TS, message: { id, model: "claude-opus-4-8", usage: { input_tokens: i, output_tokens: 0 } } }) + "\n";

  await post("/register", { pid: broker.pid, cwd: CWD, git_root: null, tty: null, summary: "RG", role: null, model: null });
  const sess = (c: CostsBody) => c.rows.find((r) => r.session_id === "ms-regrow-1");

  writeFileSync(file, rec("g1", 1000));
  let t = Math.floor(Date.now() / 1000) - 30;
  utimesSync(file, t, t);
  let got = await pollCosts(A3_WIN, (c) => (sess(c)?.input ?? 0) === 1000);
  expect(sess(got)!.input).toBe(1000);

  // rewrite line 1 (1000 -> 2000, same length so the OLD cursor still aligns to its
  // newline) AND append a second record. A stale-cursor tail parse keeps line 1 at
  // 1000 and adds 500 = 1500; the anchor mismatch forces a reparse -> 2500.
  writeFileSync(file, rec("g1", 2000) + rec("g2", 500));
  t += 10;
  utimesSync(file, t, t);
  got = await pollCosts(A3_WIN, (c) => (sess(c)?.input ?? 0) === 2500);
  expect(sess(got)!.input).toBe(2500);
});

test("A3: a plain append still tail-parses (anchor intact, no double count, no miss)", async () => {
  const CWD = "/tmp/ms-append";
  const projDir = join(PROJECTS_ROOT, projectDirName(CWD));
  mkdirSync(projDir, { recursive: true });
  const file = join(projDir, "ms-append-1.jsonl");
  const rec = (id: string, i: number) =>
    JSON.stringify({ type: "assistant", sessionId: "ms-append-1", timestamp: new Date().toISOString(), message: { id, model: "claude-opus-4-8", usage: { input_tokens: i, output_tokens: 0 } } }) + "\n";

  await post("/register", { pid: broker.pid, cwd: CWD, git_root: null, tty: null, summary: "AP", role: null, model: null });
  const sess = (c: CostsBody) => c.rows.find((r) => r.session_id === "ms-append-1");

  const line1 = rec("p1", 1000); // captured once so the append leaves line 1 byte-identical
  writeFileSync(file, line1);
  let got = await pollCosts(A3_WIN, (c) => (sess(c)?.input ?? 0) === 1000);
  expect(sess(got)!.input).toBe(1000);

  writeFileSync(file, line1 + rec("p2", 500));
  got = await pollCosts(A3_WIN, (c) => (sess(c)?.input ?? 0) === 1500);
  expect(sess(got)!.input).toBe(1500); // p1 counted once (not 2500), p2 added
});

// A3 (round 2): a reset drops the file's PRIOR contribution (its stored session
// ids), not just the ids present in the newly parsed content. Otherwise a
// rewrite-to-empty or a changed session_id strands stale, double-countable rows.

test("A3: a rewrite-to-empty clears the file's whole ledger contribution", async () => {
  const CWD = "/tmp/ms-empty";
  const projDir = join(PROJECTS_ROOT, projectDirName(CWD));
  mkdirSync(projDir, { recursive: true });
  const file = join(projDir, "ms-empty-1.jsonl");
  const rec = (i: number) =>
    JSON.stringify({ type: "assistant", sessionId: "ms-empty-1", timestamp: new Date().toISOString(), message: { id: "e1", model: "claude-opus-4-8", usage: { input_tokens: i, output_tokens: 0 } } }) + "\n";

  await post("/register", { pid: broker.pid, cwd: CWD, git_root: null, tty: null, summary: "E", role: null, model: null });
  const sess = (c: CostsBody) => c.rows.find((r) => r.session_id === "ms-empty-1");

  writeFileSync(file, rec(1000));
  let got = await pollCosts(A3_WIN, (c) => (sess(c)?.input ?? 0) === 1000);
  expect(sess(got)!.input).toBe(1000);

  // truncate to empty: the reparse yields zero records, so deleting only the
  // newly parsed ids would delete nothing. Deleting the STORED ids clears it.
  writeFileSync(file, "");
  got = await pollCosts(A3_WIN, (c) => sess(c) === undefined);
  expect(sess(got)).toBeUndefined(); // contribution gone, not stuck at 1000
});

test("A3: an in-place rewrite that changes the session_id drops the old session's rows", async () => {
  const CWD = "/tmp/ms-sidchange";
  const projDir = join(PROJECTS_ROOT, projectDirName(CWD));
  mkdirSync(projDir, { recursive: true });
  const file = join(projDir, "ms-sidchange.jsonl");
  const rec = (sid: string, id: string, i: number) =>
    JSON.stringify({ type: "assistant", sessionId: sid, timestamp: new Date().toISOString(), message: { id, model: "claude-opus-4-8", usage: { input_tokens: i, output_tokens: 0 } } }) + "\n";

  await post("/register", { pid: broker.pid, cwd: CWD, git_root: null, tty: null, summary: "SC", role: null, model: null });

  // two records under session S1 (so the single-record rewrite below is strictly
  // smaller -> a size-shrink reset)
  writeFileSync(file, rec("ms-sid-1", "a1", 1000) + rec("ms-sid-1", "a2", 500));
  await pollCosts(A3_WIN, (c) => (c.rows.find((r) => r.session_id === "ms-sid-1")?.input ?? 0) === 1500);

  // rewrite the whole file to one record under a DIFFERENT session S2
  writeFileSync(file, rec("ms-sid-2", "b1", 700));
  const got = await pollCosts(
    A3_WIN,
    (c) => (c.rows.find((r) => r.session_id === "ms-sid-2")?.input ?? 0) === 700 && c.rows.find((r) => r.session_id === "ms-sid-1") === undefined
  );
  expect(got.rows.find((r) => r.session_id === "ms-sid-2")!.input).toBe(700);
  expect(got.rows.find((r) => r.session_id === "ms-sid-1")).toBeUndefined(); // old session removed, not double-counted
});

// A3 (round 3): the legacy-row self-heal. A session_index row written before the
// session_ids column existed has it NULL; if the transcript was rewritten to empty
// BEFORE any post-upgrade tick recorded session_ids, the old code could not know
// the file's prior contribution and left its cost_ledger rows stranded. The heal
// forces a full reparse of legacy rows and, for a flat top-level file, seeds the
// filename stem as the prior session id so the stale rows are dropped.

test("A3: a legacy session_index row (NULL session_ids) self-heals a pre-upgrade rewrite-to-empty", async () => {
  const CWD = "/tmp/ms-legacy";
  const dir = join(PROJECTS_ROOT, projectDirName(CWD));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "ms-legacy-1.jsonl");
  // the file's PRE-empty content, only used to size the legacy cursor realistically
  const oldContent =
    JSON.stringify({ type: "assistant", sessionId: "ms-legacy-1", timestamp: "2026-07-08T10:00:00Z", message: { id: "leg1", model: "claude-opus-4-8", usage: { input_tokens: 1000, output_tokens: 0 } } }) + "\n";
  // On disk the file is ALREADY empty (the rewrite happened "pre-upgrade"). No seat
  // is registered here, so the ONLY thing making this project interested — and thus
  // scanned — is the seeded index row, which we insert together with the ledger rows
  // in one transaction so no tick ever observes a half-seeded (already-healed) state.
  writeFileSync(file, "");
  const wdb = new Database(DB_FILE);
  wdb.run("PRAGMA busy_timeout = 3000");
  wdb.transaction(() => {
    wdb.run(
      "INSERT OR REPLACE INTO session_index (file_path, parent_session_id, bytes_parsed, mtime_ms, anchor_hash, session_ids) VALUES (?, NULL, ?, 0, NULL, NULL)",
      [file, Buffer.byteLength(oldContent)]
    );
    wdb.run(
      "INSERT INTO cost_ledger (session_id, attr_session_id, model, bucket_ts, input, output, cache_write, cache_read) VALUES (?, ?, ?, 0, 1000, 0, 0, 0)",
      ["ms-legacy-1", "ms-legacy-1", "claude-opus-4-8"]
    );
    wdb.run("INSERT OR IGNORE INTO seen_msgs (session_id, msg_id) VALUES (?, ?)", ["ms-legacy-1", "leg1"]);
  })();
  const seeded = wdb.query("SELECT COUNT(*) AS c FROM cost_ledger WHERE session_id = ?").get("ms-legacy-1") as { c: number };
  wdb.close();
  expect(seeded.c).toBe(1); // precondition: the stale ledger row exists before the heal

  // the heal runs on a normal index tick; poll the ledger until the stale row is gone
  let gone = false;
  for (let i = 0; i < 60; i++) {
    const row = peekDb((db) => db.query("SELECT COUNT(*) AS c FROM cost_ledger WHERE session_id = ?").get("ms-legacy-1")) as { c: number };
    if (row.c === 0) { gone = true; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(gone).toBe(true); // legacy heal deleted the stranded contribution (stem-seeded prior id)
  const idx = peekDb((db) => db.query("SELECT session_ids FROM session_index WHERE file_path = ?").get(file)) as { session_ids: string | null };
  expect(idx.session_ids).not.toBeNull(); // and recorded session_ids so the row is never legacy again
});

// B: /log message history for `patrol watch`.

type LogMsg = {
  id: number;
  from_id: string;
  to_id: string;
  text: string;
  sent_at: string;
  delivered: boolean;
  from_role: string | null;
  from_model: string | null;
  to_role: string | null;
  to_model: string | null;
};
type LogBody = { messages: LogMsg[]; latest_id: number };

test("B: /log returns history with both endpoints' context, honoring after_id and limit", async () => {
  const s = await post("/register", { pid: process.pid, cwd: "/tmp/log-s", git_root: null, tty: null, summary: "s", role: "orchestrator", model: "fable" });
  const sender = ((await s.json()) as { id: string }).id;
  const r = await post("/register", { pid: broker.pid, cwd: "/tmp/log-r", git_root: null, tty: null, summary: "r", role: "executor", model: "opus" });
  const recv = ((await r.json()) as { id: string }).id;

  // baseline cursor: only messages after this are ours
  const base = ((await (await post("/log", {})).json()) as LogBody).latest_id;
  for (const t of ["one", "two", "three"]) {
    expect((await post("/send-message", { from_id: sender, to_id: recv, text: t })).status).toBe(200);
  }
  // v0.2.3: poll LEASES, ack DELIVERS — so settle the batch to make these delivered.
  const polled = await post("/poll-messages", { id: recv });
  const polledIds = ((await polled.json()) as { messages: Array<{ id: number }> }).messages.map((m) => m.id);
  await post("/ack", { id: recv, message_ids: polledIds });

  const all = (await (await post("/log", { after_id: base })).json()) as LogBody;
  expect(all.messages.map((m) => m.text)).toEqual(["one", "two", "three"]); // id ASC
  expect(all.messages.every((m) => m.from_id === sender && m.to_id === recv)).toBe(true);
  expect(all.messages.every((m) => m.delivered === true)).toBe(true); // polled AND acked
  const m0 = all.messages[0]!;
  expect(m0.from_role).toBe("orchestrator");
  expect(m0.from_model).toBe("fable");
  expect(m0.to_role).toBe("executor");
  expect(m0.to_model).toBe("opus");
  expect(all.latest_id).toBe(all.messages[all.messages.length - 1]!.id); // MAX(id) over the table

  // after_id cursor: strictly newer than the first row
  const rest = (await (await post("/log", { after_id: m0.id })).json()) as LogBody;
  expect(rest.messages.map((m) => m.text)).toEqual(["two", "three"]);

  // limit caps the batch; latest_id stays table-wide
  const limited = (await (await post("/log", { after_id: base, limit: 2 })).json()) as LogBody;
  expect(limited.messages.map((m) => m.text)).toEqual(["one", "two"]);
  expect(limited.latest_id).toBe(all.latest_id);
});

test("B: /log resolves a dead seat via seat_runs; a cli sender yields null context", async () => {
  const s = await post("/register", { pid: process.pid, cwd: "/tmp/log-dead-s", git_root: null, tty: null, summary: "s", role: "orchestrator", model: "fable" });
  const sender = ((await s.json()) as { id: string }).id;
  const r = await post("/register", { pid: broker.pid, cwd: "/tmp/log-dead-r", git_root: null, tty: null, summary: "r", role: "executor", model: "opus" });
  const recv = ((await r.json()) as { id: string }).id;

  const base = ((await (await post("/log", {})).json()) as LogBody).latest_id;
  await post("/send-message", { from_id: sender, to_id: recv, text: "seat-msg" });
  await post("/send-message", { from_id: "cli", to_id: recv, text: "cli-msg" });

  // kill the sender: its live row goes, but its seat_run persists (with role/model)
  await post("/unregister", { id: sender });

  const log = (await (await post("/log", { after_id: base })).json()) as LogBody;
  const seatMsg = log.messages.find((m) => m.text === "seat-msg")!;
  expect(seatMsg.from_role).toBe("orchestrator"); // resolved from seat_runs, not the deleted seats row
  expect(seatMsg.from_model).toBe("fable");
  const cliMsg = log.messages.find((m) => m.text === "cli-msg")!;
  expect(cliMsg.from_role).toBeNull(); // "cli" has no run
  expect(cliMsg.from_model).toBeNull();
  expect(cliMsg.to_role).toBe("executor"); // recipient still resolves
});

test("B: /log is auth-gated and rejects a bad after_id/limit", async () => {
  expect((await post("/log", {}, "wrong")).status).toBe(401);
  expect((await post("/log", { after_id: -1 })).status).toBe(400);
  expect((await post("/log", { limit: 0 })).status).toBe(400);
  expect((await post("/log", { limit: -5 })).status).toBe(400);
});

// --- v0.2.3 lease/ack delivery -------------------------------------------------
// The whole point of lease/ack: a consumer that dies between poll and push must not
// swallow the message. These run against their OWN broker with a tiny LEASE_TTL, so an
// abandoned lease can actually expire inside a test instead of in 15 minutes.
describe("lease/ack delivery", () => {
  const L_PORT = 17903;
  const L_BASE = `http://127.0.0.1:${L_PORT}`;
  const L_TTL_MS = 400;
  const ldir = mkdtempSync(join(tmpdir(), "patrol-lease-"));
  const L_SECRET = join(ldir, "secret");
  let lbroker: ReturnType<typeof Bun.spawn>;
  let LTOKEN = "";

  const lpost = (path: string, body: unknown) =>
    fetch(`${L_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-patrol-token": LTOKEN },
      body: JSON.stringify(body),
    });
  const poll = async (id: string) =>
    ((await (await lpost("/poll-messages", { id })).json()) as { messages: Array<{ id: number; text: string }> }).messages;
  const seat = async (pid: number) =>
    ((await (await lpost("/register", {
      pid, cwd: "/l", git_root: null, tty: null, summary: "", role: "r", model: "m", profile: "peer",
    })).json()) as { id: string }).id;

  beforeAll(async () => {
    lbroker = Bun.spawn(["bun", new URL("../src/broker.ts", import.meta.url).pathname], {
      env: {
        ...process.env,
        CLAUDE_PATROL_PORT: String(L_PORT),
        CLAUDE_PATROL_DB: join(ldir, "l.db"),
        CLAUDE_PATROL_SECRET_FILE: L_SECRET,
        CLAUDE_PATROL_PROJECTS_ROOT: join(ldir, "projects"),
        CLAUDE_PATROL_LEASE_TTL_MS: String(L_TTL_MS),
      },
      stdio: ["ignore", "ignore", "inherit"],
    });
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${L_BASE}/health`)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    LTOKEN = (await Bun.file(L_SECRET).text()).trim();
  });
  afterAll(() => {
    lbroker.kill();
    rmSync(ldir, { recursive: true, force: true });
  });

  test("crash during a batch: an unacked lease expires and the message REDELIVERS", async () => {
    const id = await seat(process.pid);
    await lpost("/send-message", { from_id: "cli", to_id: id, text: "survive-the-crash" });

    // Consumer leases the batch, then "dies" — it never acks.
    const leased = await poll(id);
    expect(leased.map((m) => m.text)).toEqual(["survive-the-crash"]);

    // While the lease is held, the message is NOT handed to anyone else.
    expect(await poll(id)).toHaveLength(0);

    // Once the lease expires, the work is assumed lost and comes back. Without this, a
    // seat that crashed mid-push would have silently eaten the message.
    await new Promise((r) => setTimeout(r, L_TTL_MS + 250));
    const redelivered = await poll(id);
    expect(redelivered.map((m) => m.text)).toEqual(["survive-the-crash"]);
    expect(redelivered[0]!.id).toBe(leased[0]!.id); // same row, not a copy
  });

  test("ack settles the batch: it never comes back, even after the lease would have expired", async () => {
    const id = await seat(process.pid);
    await lpost("/send-message", { from_id: "cli", to_id: id, text: "settled" });

    const leased = await poll(id);
    expect(leased).toHaveLength(1);
    expect((await lpost("/ack", { id, message_ids: [leased[0]!.id] })).status).toBe(200);

    // Past the TTL — an acked row must NOT be resurrected by lease expiry.
    await new Promise((r) => setTimeout(r, L_TTL_MS + 250));
    expect(await poll(id)).toHaveLength(0);
  });

  test("double-ack is idempotent", async () => {
    const id = await seat(process.pid);
    await lpost("/send-message", { from_id: "cli", to_id: id, text: "twice" });
    const leased = await poll(id);
    const ids = leased.map((m) => m.id);

    expect((await lpost("/ack", { id, message_ids: ids })).status).toBe(200);
    expect((await lpost("/ack", { id, message_ids: ids })).status).toBe(200); // retry, double push
    expect(await poll(id)).toHaveLength(0);
  });

  test("acking a foreign or unknown message id is a no-op", async () => {
    // Distinct live pids on purpose: registering a second seat on the SAME pid is treated
    // as that seat re-registering, which endSeat's the old row and purges its undelivered
    // mail — the victim's message would vanish for the wrong reason and the test would lie.
    const victim = await seat(process.pid);
    const attacker = await seat(process.ppid);
    expect(attacker).not.toBe(victim);
    await lpost("/send-message", { from_id: "cli", to_id: victim, text: "not-yours" });

    const leased = await poll(victim);
    const victimMsgId = leased[0]!.id;

    // Another seat tries to settle mail addressed to the victim, and an id that does not
    // exist at all. Both must change nothing: ack is scoped by to_id.
    expect((await lpost("/ack", { id: attacker, message_ids: [victimMsgId] })).status).toBe(200);
    expect((await lpost("/ack", { id: attacker, message_ids: [999_999] })).status).toBe(200);

    // The victim's message was never settled, so it redelivers to the victim on expiry.
    await new Promise((r) => setTimeout(r, L_TTL_MS + 250));
    expect((await poll(victim)).map((m) => m.text)).toEqual(["not-yours"]);
  });

  test("ack validates its shape", async () => {
    const id = await seat(process.pid);
    expect((await lpost("/ack", { id, message_ids: "nope" })).status).toBe(400);
    expect((await lpost("/ack", { id, message_ids: [1.5] })).status).toBe(400);
    expect((await lpost("/ack", { id: "BAD", message_ids: [1] })).status).toBe(400);
  });
});
