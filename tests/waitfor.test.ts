/**
 * WP-O: /wait-for long-poll — block until a seat reaches a desired state, against a
 * REAL broker subprocess (own port + temp db). Verifies immediate hit, mid-wait
 * transition, timeout, target-death, unknown-target, and that a pending wait does
 * NOT starve a concurrent /list-seats (the await-yields property).
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 17904;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "patrol-waitfor-"));
const SECRET_FILE = join(dir, "secret");

let broker: ReturnType<typeof Bun.spawn>;
let TOKEN = "";
const sleepers: ReturnType<typeof Bun.spawn>[] = [];

function alivePid(): { pid: number; proc: ReturnType<typeof Bun.spawn> } {
  const p = Bun.spawn(["sleep", "120"], { stdio: ["ignore", "ignore", "ignore"] });
  sleepers.push(p);
  return { pid: p.pid, proc: p };
}

async function post(path: string, body: unknown, token = TOKEN) {
  return fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-patrol-token": token },
    body: JSON.stringify(body),
  });
}

async function register(): Promise<{ id: string; proc: ReturnType<typeof Bun.spawn> }> {
  const { pid, proc } = alivePid();
  const res = await post("/register", { pid, cwd: "/tmp/wf", git_root: null, tty: null, summary: "", role: "worker" });
  return { id: ((await res.json()) as { id: string }).id, proc };
}

beforeAll(async () => {
  mkdirSync(join(dir, "projects"), { recursive: true });
  broker = Bun.spawn(["bun", new URL("../src/broker.ts", import.meta.url).pathname], {
    env: { ...process.env, CLAUDE_PATROL_PORT: String(PORT), CLAUDE_PATROL_DB: join(dir, "test.db"), CLAUDE_PATROL_SECRET_FILE: SECRET_FILE, CLAUDE_PATROL_PROJECTS_ROOT: join(dir, "projects"), CLAUDE_PATROL_INDEX_INTERVAL_MS: "10000", CLAUDE_PATROL_WAITFOR_POLL_MS: "40" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${URL_BASE}/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  TOKEN = (await Bun.file(SECRET_FILE).text()).trim();
});
afterAll(() => {
  broker.kill();
  for (const s of sleepers) s.kill();
  rmSync(dir, { recursive: true, force: true });
});

const waitFor = (target: string, until: string[], timeout_ms: number) =>
  post("/wait-for", { id: "cli", target, until, timeout_ms }).then((r) => r.json() as Promise<{ reached: boolean; state: string }>);

test("target already in a desired state returns immediately, reached:true", async () => {
  const { id } = await register();
  await post("/set-state", { id, state: "working" });
  const t0 = Date.now();
  const res = await waitFor(id, ["working", "done"], 5000);
  expect(res).toEqual({ reached: true, state: "working" });
  expect(Date.now() - t0).toBeLessThan(1000); // returned promptly, didn't burn the timeout
});

test("target transitioning into the state mid-wait resolves reached:true", async () => {
  const { id } = await register(); // starts with no state -> "unknown"
  const waiting = waitFor(id, ["done"], 5000);
  // Drive the transition while the wait is in flight.
  await new Promise((r) => setTimeout(r, 120));
  await post("/set-state", { id, state: "done" });
  expect(await waiting).toEqual({ reached: true, state: "done" });
});

test("timeout with the target never reaching returns reached:false + last state, within ~timeout", async () => {
  const { id } = await register();
  await post("/set-state", { id, state: "working" });
  const t0 = Date.now();
  const res = await waitFor(id, ["done"], 300); // never becomes done
  const elapsed = Date.now() - t0;
  expect(res).toEqual({ reached: false, state: "working" }); // carries last-known state
  expect(elapsed).toBeGreaterThanOrEqual(280);
  expect(elapsed).toBeLessThan(2000); // bounded by the timeout, not hung
});

test("target dies mid-wait -> reached:false, does not hang", async () => {
  const { id, proc } = await register();
  const waiting = waitFor(id, ["done"], 10_000); // would wait 10s if it hung
  await new Promise((r) => setTimeout(r, 100));
  proc.kill(); // the seat's pid is now dead
  const t0 = Date.now();
  const res = await waiting;
  expect(res.reached).toBe(false);
  expect(res.state).toBe("unknown");
  expect(Date.now() - t0).toBeLessThan(5000); // resolved well before the 10s timeout
});

test("a dead/unknown target id resolves immediately (does not hang)", async () => {
  const t0 = Date.now();
  const res = await waitFor("zzzzzzzz", ["done"], 10_000);
  expect(res).toEqual({ reached: false, state: "unknown" });
  expect(Date.now() - t0).toBeLessThan(1000);
});

test("a pending /wait-for does NOT starve a concurrent /list-seats (await yields the thread)", async () => {
  const { id } = await register();
  const waiting = waitFor(id, ["done"], 1500); // will not be reached -> pending ~1.5s
  // While that wait is open, a normal request must still respond promptly.
  const t0 = Date.now();
  const list = await post("/list-seats", { scope: "machine", cwd: "/", git_root: null });
  expect(list.ok).toBe(true);
  expect(Date.now() - t0).toBeLessThan(500); // not blocked behind the long-poll
  expect(((await waiting) as { reached: boolean }).reached).toBe(false);
});

test("validate rejects a bad until / oversized timeout (400)", async () => {
  const { id } = await register();
  expect((await post("/wait-for", { id: "cli", target: id, until: [], timeout_ms: 100 })).status).toBe(400); // empty until
  expect((await post("/wait-for", { id: "cli", target: id, until: ["nope"], timeout_ms: 100 })).status).toBe(400); // bad state
  expect((await post("/wait-for", { id: "cli", target: id, until: ["done"], timeout_ms: 9_999_999 })).status).toBe(400); // over cap
});
