/**
 * v0.2.6 budget-alert integration test. Spins a real broker on an alternate port
 * with a temp DB + secret + fixture projects tree, seeds per-seat spend into the
 * ledger the way the cost tests do (an assistant-usage jsonl the background indexer
 * picks up), and asserts the observe-only cap behaviour:
 *   under budget -> no alert; crossing -> exactly one message to the recipient;
 *   a second tick still over -> NO duplicate; no budget -> never alerts;
 *   no live recipient -> no crash.
 *
 * Distinct LIVE pids: the broker reaps a seat whose pid is dead, and a re-register
 * on the SAME pid retires the prior seat — so every concurrent seat needs its own
 * living process. We hold cheap `sleep` children for that.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDirName } from "../src/costs.ts";

const PORT = 17901;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "patrol-budget-"));
const SECRET_FILE = join(dir, "secret");
const DB_FILE = join(dir, "test.db");
const PROJECTS_ROOT = join(dir, "projects");

let broker: ReturnType<typeof Bun.spawn>;
let TOKEN: string;
const holds: ReturnType<typeof Bun.spawn>[] = [];

async function post(path: string, body: unknown, token = TOKEN) {
  return fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-patrol-token": token },
    body: JSON.stringify(body),
  });
}

// A living process whose pid a seat can register under. Reaped in afterAll.
function liveHold(): number {
  const p = Bun.spawn(["sleep", "600"], { stdio: ["ignore", "ignore", "ignore"] });
  holds.push(p);
  return p.pid;
}

// Seed one assistant-usage record for `sessionId` under `cwd`'s project dir. The
// background indexer folds it into the ledger; a seat registered with this session_id
// (fast-path) then owns that spend. opus input is $5/MTok, so { i: 4000 } == $0.02.
function seedCost(cwd: string, sessionId: string, tokens: { i: number; o: number }, model = "claude-opus-4-8") {
  const projDir = join(PROJECTS_ROOT, projectDirName(cwd));
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(projDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: "assistant",
      sessionId,
      timestamp: new Date().toISOString(),
      message: { id: `${sessionId}-a1`, model, usage: { input_tokens: tokens.i, output_tokens: tokens.o } },
    }) + "\n"
  );
}

type CostsBody = { rows: Array<{ seat_id: string | null; session_id: string; cost_usd: number }>; total_usd: number };

// The ledger fills on a background tick; poll instead of racing it. Because indexTick
// is synchronous (index -> checkBudgets, no await between), once /costs reflects a
// session's spend, that same tick's budget check has ALREADY run on it — so "cost
// visible" is a deterministic proxy for "budget checked", no sleep needed.
async function pollCostVisible(sessionId: string, tries = 80): Promise<CostsBody> {
  let last: CostsBody = { rows: [], total_usd: 0 };
  for (let i = 0; i < tries; i++) {
    last = (await (await post("/costs", { since: "2000-01-01T00:00:00Z" })).json()) as CostsBody;
    if (last.rows.some((r) => r.session_id === sessionId)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

type Msg = { id: number; from_id: string; text: string };

// Poll a seat's inbox until an alert from the reserved "patrol" sender lands (or give
// up). A poll LEASES, so the returned alert won't re-appear on a later poll.
async function pollForAlert(seatId: string, tries = 80): Promise<Msg[]> {
  for (let i = 0; i < tries; i++) {
    const { messages } = (await (await post("/poll-messages", { id: seatId })).json()) as { messages: Msg[] };
    const patrol = messages.filter((m) => m.from_id === "patrol");
    if (patrol.length > 0) return patrol;
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

async function listSeats(): Promise<Array<{ id: string; handle: string | null; role: string | null }>> {
  return (await (await post("/list-seats", { scope: "machine", cwd: "/", git_root: null })).json()) as Array<{
    id: string;
    handle: string | null;
    role: string | null;
  }>;
}

// Fresh slate per test: unregister every seat so resolveAlertRecipient can never pick
// a stale orchestrator from a prior test (multiple live orchestrators would be
// ambiguous). Distinct session ids per test keep the persisted ledger from colliding.
async function clearSeats() {
  for (const s of await listSeats()) await post("/unregister", { id: s.id });
}

async function registerSeat(opts: {
  pid: number;
  cwd: string;
  role: string;
  session_id?: string;
  budget_usd?: number;
}): Promise<string> {
  const res = await post("/register", {
    pid: opts.pid,
    cwd: opts.cwd,
    git_root: null,
    tty: null,
    summary: "",
    role: opts.role,
    model: "opus",
    session_id: opts.session_id ?? null,
    budget_usd: opts.budget_usd ?? null,
  });
  return ((await res.json()) as { id: string }).id;
}

beforeAll(async () => {
  mkdirSync(PROJECTS_ROOT, { recursive: true });
  broker = Bun.spawn(["bun", new URL("../src/broker.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      CLAUDE_PATROL_PORT: String(PORT),
      CLAUDE_PATROL_DB: DB_FILE,
      CLAUDE_PATROL_SECRET_FILE: SECRET_FILE,
      CLAUDE_PATROL_PROJECTS_ROOT: PROJECTS_ROOT,
      CLAUDE_PATROL_INDEX_INTERVAL_MS: "80", // keep budget/index ticks fast for the test
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
  for (const h of holds) h.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("a missing recipient no-ops without crashing the cost tick", async () => {
  // No orchestrator registered: the crossing has nowhere to page. This must not throw
  // inside indexTick and take the broker down.
  await clearSeats();
  const cwd = "/tmp/bud-lonely";
  seedCost(cwd, "budlonely", { i: 4000, o: 0 }); // $0.02 > $0.01 cap
  await registerSeat({ pid: liveHold(), cwd, role: "worker", session_id: "budlonely", budget_usd: 0.01 });

  await pollCostVisible("budlonely"); // crossing indexed -> checkBudgets ran with no recipient

  // Broker is still alive and fully serving after the recipient-less crossing.
  expect((await fetch(`${URL_BASE}/health`)).ok).toBe(true);
  const costs = (await (await post("/costs", { since: "2000-01-01T00:00:00Z" })).json()) as CostsBody;
  expect(costs.rows.some((r) => r.session_id === "budlonely")).toBe(true);
});

test("a seat under its budget never alerts", async () => {
  await clearSeats();
  const orchId = await registerSeat({ pid: liveHold(), cwd: "/tmp/bud-orch", role: "orchestrator" });

  const cwd = "/tmp/bud-under";
  seedCost(cwd, "budunder", { i: 1000, o: 0 }); // $0.005, cap $1.00
  await registerSeat({ pid: liveHold(), cwd, role: "worker", session_id: "budunder", budget_usd: 1.0 });

  // Once the spend is visible, the same tick's budget check has run on it — so an
  // empty inbox here is a decision, not a race.
  await pollCostVisible("budunder");
  const { messages } = (await (await post("/poll-messages", { id: orchId })).json()) as { messages: Msg[] };
  expect(messages.filter((m) => m.from_id === "patrol")).toHaveLength(0);
});

test("crossing the cap pings the recipient exactly once (and a later tick does NOT duplicate)", async () => {
  await clearSeats();
  const orchId = await registerSeat({ pid: liveHold(), cwd: "/tmp/bud-orch", role: "orchestrator" });

  const cwd = "/tmp/bud-cross";
  seedCost(cwd, "budcross", { i: 4000, o: 0 }); // $0.02 > $0.01 cap
  const capId = await registerSeat({ pid: liveHold(), cwd, role: "worker", session_id: "budcross", budget_usd: 0.01 });
  const handle = (await listSeats()).find((s) => s.id === capId)!.handle!;

  const alerts = await pollForAlert(orchId);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]!.text).toBe(`⚠ ${handle} crossed its $0.01 budget — now $0.02`);

  // Several more ticks run (index interval is 80ms). The budget_alerted latch must
  // stop a second, duplicate alert — a fresh (unleased) row would show up here.
  await new Promise((r) => setTimeout(r, 500));
  const { messages } = (await (await post("/poll-messages", { id: orchId })).json()) as { messages: Msg[] };
  expect(messages.filter((m) => m.from_id === "patrol")).toHaveLength(0);
});

test("a seat with no budget cap never alerts even when it spends", async () => {
  await clearSeats();
  const orchId = await registerSeat({ pid: liveHold(), cwd: "/tmp/bud-orch", role: "orchestrator" });

  const cwd = "/tmp/bud-none";
  seedCost(cwd, "budnone", { i: 4000, o: 0 }); // $0.02 spent, but NO cap set
  await registerSeat({ pid: liveHold(), cwd, role: "worker", session_id: "budnone" }); // budget_usd omitted

  await pollCostVisible("budnone");
  const { messages } = (await (await post("/poll-messages", { id: orchId })).json()) as { messages: Msg[] };
  expect(messages.filter((m) => m.from_id === "patrol")).toHaveLength(0);
});

test("register rejects a non-positive budget_usd at the trust boundary", async () => {
  await clearSeats();
  const bad = await post("/register", {
    pid: liveHold(),
    cwd: "/tmp/bud-bad",
    git_root: null,
    tty: null,
    summary: "",
    role: "worker",
    model: "opus",
    budget_usd: 0,
  });
  expect(bad.status).toBe(400);
});
