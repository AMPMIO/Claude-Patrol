/**
 * WP-Q: readable seat handles — broker assignment, dedup, /rename, and reap,
 * against a REAL broker subprocess (own port + temp db).
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 17902;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "patrol-handles-"));
const SECRET_FILE = join(dir, "secret");

let broker: ReturnType<typeof Bun.spawn>;
let TOKEN = "";
const sleepers: ReturnType<typeof Bun.spawn>[] = [];

function alivePid(): number {
  const p = Bun.spawn(["sleep", "120"], { stdio: ["ignore", "ignore", "ignore"] });
  sleepers.push(p);
  return p.pid;
}

async function post(path: string, body: unknown, token = TOKEN) {
  return fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-patrol-token": token },
    body: JSON.stringify(body),
  });
}

// cwd defaults to /tmp/proja so the project-suffix on a handle collision is a
// deterministic "proja" (slug of basename("/tmp/proja")).
async function register(over: Record<string, unknown> = {}): Promise<{ id: string; handle: string }> {
  const res = await post("/register", { pid: alivePid(), cwd: "/tmp/proja", git_root: null, tty: null, summary: "", role: "worker", ...over });
  const { id } = (await res.json()) as { id: string };
  const seats = (await (await post("/list-seats", { scope: "machine", cwd: "/", git_root: null })).json()) as Array<{ id: string; handle?: string }>;
  return { id, handle: seats.find((s) => s.id === id)!.handle! };
}

beforeAll(async () => {
  mkdirSync(join(dir, "projects"), { recursive: true });
  broker = Bun.spawn(["bun", new URL("../src/broker.ts", import.meta.url).pathname], {
    env: { ...process.env, CLAUDE_PATROL_PORT: String(PORT), CLAUDE_PATROL_DB: join(dir, "test.db"), CLAUDE_PATROL_SECRET_FILE: SECRET_FILE, CLAUDE_PATROL_PROJECTS_ROOT: join(dir, "projects"), CLAUDE_PATROL_INDEX_INTERVAL_MS: "10000" },
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

test("same-role seats get DISTINCT handles: base, then base-proj, then base-hex", async () => {
  const a = await register({ role: "builder" });
  const b = await register({ role: "builder" });
  const c = await register({ role: "builder" });
  expect(a.handle).toBe("builder"); // base is free
  expect(b.handle).toBe("builder-proja"); // base taken -> project suffix
  // base + base-proj both taken -> last-resort 4-hex of the seat's own id
  expect(c.handle).not.toBe("builder");
  expect(c.handle).not.toBe("builder-proja");
  expect(c.handle.startsWith("builder-")).toBe(true);
  // All three distinct (handles must disambiguate).
  expect(new Set([a.handle, b.handle, c.handle]).size).toBe(3);
});

test("handle derives from the requested name, slugified", async () => {
  const s = await register({ name: "Front End!!", role: "x" });
  expect(s.handle).toBe("front-end"); // lowercased, non-alnum collapsed to a single dash, trimmed
});

test("/rename returns the deduped handle; a taken name gets a suffix", async () => {
  const boss = await register({ name: "lead", role: "r" });
  expect(boss.handle).toBe("lead");
  const other = await register({ role: "r" });

  // Rename to a FREE name -> exactly that.
  const free = (await (await post("/rename", { id: other.id, name: "captain" })).json()) as { ok: boolean; handle: string };
  expect(free).toEqual({ ok: true, handle: "captain" });

  // Rename to a name a LIVE seat already holds -> a suffix, never a duplicate.
  const clash = (await (await post("/rename", { id: other.id, name: "lead" })).json()) as { ok: boolean; handle: string };
  expect(clash.ok).toBe(true);
  expect(clash.handle).not.toBe("lead");
  expect(clash.handle.startsWith("lead-")).toBe(true);

  // A non-live seat can't be renamed.
  const dead = (await (await post("/rename", { id: "zzzzzzzz", name: "ghost" })).json()) as { ok: boolean };
  expect(dead.ok).toBe(false);
  // Empty name is a 400.
  expect((await post("/rename", { id: other.id, name: "" })).status).toBe(400);
});

test("a handle is reaped when the seat dies — the name frees up for reuse", async () => {
  const first = await register({ name: "solo", role: "z" });
  expect(first.handle).toBe("solo");
  await post("/unregister", { id: first.id }); // endSeat drops the row (and its handle)
  // The freed name is assignable again to a NEW seat (proves the dead handle is gone).
  const second = await register({ name: "solo", role: "z" });
  expect(second.handle).toBe("solo");
  expect(second.id).not.toBe(first.id);
  // The dead seat is absent from the board.
  const seats = (await (await post("/list-seats", { scope: "machine", cwd: "/", git_root: null })).json()) as Array<{ id: string }>;
  expect(seats.some((s) => s.id === first.id)).toBe(false);
});
