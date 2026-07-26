/**
 * v0.3 crash-redelivery RETENTION: the half that stops adoption from being a leak.
 *
 * Its own broker because it needs a tightened sweep cadence and a retention window it can
 * actually cross — the main identity suite keeps production-ish values so its adoption tests
 * are not silently racing the purge they are meant to outlive.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 17912;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "patrol-retention-"));
const SECRET_FILE = join(dir, "secret");
const DB_FILE = join(dir, "test.db");
const SWEEP_MS = 120;

let broker: ReturnType<typeof Bun.spawn>;
let SECRET: string;

async function post(path: string, body: unknown) {
  return fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-patrol-token": SECRET },
    body: JSON.stringify(body),
  });
}

function queued(toId: string): number {
  const db = new Database(DB_FILE, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS c FROM messages WHERE to_id = ? AND delivered = 0").get(toId) as { c: number }).c;
  } finally {
    db.close();
  }
}

// Wait for a condition the background sweep produces, rather than sleeping a fixed multiple of
// the interval — a fixed sleep is how this kind of test turns flaky on a loaded machine.
async function waitFor(fn: () => boolean, tries = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, SWEEP_MS / 2));
  }
  return fn();
}

beforeAll(async () => {
  broker = Bun.spawn(["bun", new URL("../src/broker.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      CLAUDE_PATROL_PORT: String(PORT),
      CLAUDE_PATROL_DB: DB_FILE,
      CLAUDE_PATROL_SECRET_FILE: SECRET_FILE,
      CLAUDE_PATROL_PROJECTS_ROOT: join(dir, "projects"),
      CLAUDE_PATROL_SWEEP_INTERVAL_MS: String(SWEEP_MS),
      CLAUDE_PATROL_ORPHAN_RETENTION_MS: "0", // every orphan is instantly past its window
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${URL_BASE}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  SECRET = (await Bun.file(SECRET_FILE).text()).trim();
});

afterAll(() => {
  broker.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("mail nobody reclaimed inside the retention window is purged by the sweep", async () => {
  const reg = await post("/register", {
    pid: 2_000_000_001, // no such process: this seat is "crashed" from birth
    cwd: "/tmp/retention", git_root: null, tty: null, summary: "doomed",
    role: null, model: null, fleet: "ret", stable_key: "ret/worker",
  });
  const { id } = (await reg.json()) as { id: string };

  expect(((await (await post("/send-message", { from_id: "cli", to_id: id, text: "orphan me" })).json()) as { ok: boolean }).ok).toBe(true);
  expect(queued(id)).toBe(1);

  // The sweep notices the dead pid; endSeat RETAINS the mail (the seat has a stable_key), and
  // the same pass then finds it already past a zero-length window and purges it. Both halves
  // are exercised: without retention there is nothing to adopt, without the purge it leaks.
  expect(await waitFor(() => queued(id) === 0)).toBe(true);
});

test("a live seat's undelivered mail is never touched by the orphan purge", async () => {
  const reg = await post("/register", {
    pid: process.pid, cwd: "/tmp/retention", git_root: null, tty: null, summary: "alive",
    role: null, model: null, fleet: "ret", stable_key: "ret/alive",
  });
  const { id } = (await reg.json()) as { id: string };
  await post("/send-message", { from_id: "cli", to_id: id, text: "still mine" });

  // Several sweep intervals with a zero retention window: a purge keyed on anything weaker
  // than "this seat no longer exists" would eat this.
  await new Promise((r) => setTimeout(r, SWEEP_MS * 5));
  expect(queued(id)).toBe(1);
});
