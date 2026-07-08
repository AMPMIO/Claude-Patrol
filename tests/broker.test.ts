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

beforeAll(async () => {
  // fixture projects tree: one opus session + one subagent transcript
  const projDir = join(PROJECTS_ROOT, "-tmp-projA", "sessA", "subagents");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(PROJECTS_ROOT, "-tmp-projA", "sessA.jsonl"),
    JSON.stringify({ type: "assistant", sessionId: "sessA", timestamp: "2026-07-08T10:00:00Z", message: { id: "m1", model: "claude-opus-4-8", usage: { input_tokens: 1000, output_tokens: 2000 } } })
  );
  writeFileSync(
    join(projDir, "agent-1.jsonl"),
    JSON.stringify({ type: "assistant", sessionId: "subX", timestamp: "2026-07-08T10:10:00Z", message: { id: "s1", model: "claude-sonnet-5", usage: { input_tokens: 4000, output_tokens: 1000 } } })
  );

  broker = Bun.spawn(["bun", new URL("../src/broker.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      CLAUDE_PATROL_PORT: String(PORT),
      CLAUDE_PATROL_DB: join(dir, "test.db"),
      CLAUDE_PATROL_SECRET_FILE: SECRET_FILE,
      CLAUDE_PATROL_PROJECTS_ROOT: PROJECTS_ROOT,
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
  const res = await post("/send-message", { from_id: "cli", to_id: "nope", text: "x" });
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

  const res = await post("/costs", { since: "2000-01-01T00:00:00Z" });
  expect(res.status).toBe(200);
  const { rows, total_usd } = (await res.json()) as {
    rows: Array<{ seat_id: string | null; session_id: string; cost_usd: number }>;
    total_usd: number;
  };
  // opus session 0.055 + sonnet subagent 0.027 = 0.082 (subagents counted)
  expect(total_usd).toBeCloseTo(0.082, 4);
  expect(rows.find((r) => r.session_id === "sessA")!.seat_id).toBe(seatId);
  expect(rows.find((r) => r.session_id === "subX")!.seat_id).toBeNull();
});
