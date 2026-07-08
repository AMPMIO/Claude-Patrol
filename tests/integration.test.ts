/**
 * Cross-package integration — the seams the per-WP tests can't cover:
 * real broker + real seat-server process + the CLI verbs against both,
 * including end-to-end cost attribution from a fixture session log.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDirName } from "../src/costs.ts";

const PORT = 17901;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "patrol-int-"));
const SECRET_FILE = join(dir, "secret");
const PROJECTS_ROOT = join(dir, "projects");
const SEAT_CWD = join(dir, "seat-cwd");
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

const ENV = {
  ...process.env,
  CLAUDE_PATROL_PORT: String(PORT),
  CLAUDE_PATROL_DB: join(dir, "test.db"),
  CLAUDE_PATROL_SECRET_FILE: SECRET_FILE,
  CLAUDE_PATROL_PROJECTS_ROOT: PROJECTS_ROOT,
};

let broker: ReturnType<typeof Bun.spawn>;
let seat: ReturnType<typeof Bun.spawn>;

function fixtureSessionLog() {
  // one assistant entry with usage, timestamped now — inside the ±120s
  // attribution window around the seat's registration
  const projDir = join(PROJECTS_ROOT, projectDirName(SEAT_CWD));
  mkdirSync(projDir, { recursive: true });
  const entry = {
    type: "assistant",
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
    message: {
      id: "msg_int_1",
      model: "claude-opus-4-8",
      usage: { input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
  writeFileSync(join(projDir, `${SESSION_ID}.jsonl`), JSON.stringify(entry) + "\n");
}

async function cli(args: string[]): Promise<{ code: number; out: string }> {
  const r = Bun.spawnSync(["bun", new URL("../src/cli.ts", import.meta.url).pathname, ...args], {
    env: ENV,
    cwd: SEAT_CWD,
  });
  return { code: r.exitCode ?? 1, out: r.stdout.toString() + r.stderr.toString() };
}

beforeAll(async () => {
  mkdirSync(SEAT_CWD, { recursive: true });

  broker = Bun.spawn(["bun", new URL("../src/broker.ts", import.meta.url).pathname], {
    env: ENV,
    stdio: ["ignore", "ignore", "ignore"],
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${URL_BASE}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  // AFTER broker start: /costs defaults its window to since-broker-start,
  // so the fixture entry must be timestamped inside it
  fixtureSessionLog();

  // real seat-server process, registering against the real broker
  seat = Bun.spawn(["bun", new URL("../src/seat-server.ts", import.meta.url).pathname], {
    env: { ...ENV, CLAUDE_PATROL_ROLE: "builder", CLAUDE_PATROL_MODEL: "opus", CLAUDE_PATROL_PROFILE: "peer" },
    cwd: SEAT_CWD,
    stdio: ["pipe", "pipe", "ignore"], // stdio MCP: keep stdin open, ignore protocol chatter
  });
  // wait until the seat shows up
  const token = (await Bun.file(SECRET_FILE).text()).trim();
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${URL_BASE}/list-seats`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-patrol-token": token },
      body: JSON.stringify({ scope: "machine", cwd: "/", git_root: null }),
    });
    if (res.ok && ((await res.json()) as unknown[]).length > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});

afterAll(() => {
  seat?.kill();
  broker?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("patrol list shows the live seat with role/model", async () => {
  const { code, out } = await cli(["list"]);
  expect(code).toBe(0);
  expect(out).toContain("builder");
  expect(out).toContain("opus");
});

test("patrol send → seat's queue via real broker", async () => {
  const list = await cli(["list"]);
  const id = list.out.match(/^([a-z0-9]{8})\b/m)?.[1];
  expect(id).toBeTruthy();
  const { code, out } = await cli(["send", id!, "integration ping"]);
  expect(code).toBe(0);
  expect(out.toLowerCase()).toContain("sent");
});

test("patrol status attributes fixture spend to the seat", async () => {
  const { code, out } = await cli(["status"]);
  expect(code).toBe(0);
  expect(out).toContain("SPEND");
  // 1000 in * $5 + 2000 out * $25 per MTok = $0.055 — attributed via the
  // register-time heuristic or the query-time ±120s window (either path
  // must land it on the seat row, not the unattributed bucket)
  expect(out).toMatch(/builder.*\$0\.0[5-6]/);
  expect(out).not.toContain("unattributed");
});

test("patrol doctor exits 0 against the live broker", async () => {
  const { code, out } = await cli(["doctor"]);
  expect(code).toBe(0);
  expect(out).toContain("broker up");
});
