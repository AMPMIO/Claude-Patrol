import { test, expect, beforeAll, afterAll } from "bun:test";
import status from "../src/commands/status.ts";
import list from "../src/commands/list.ts";
import send from "../src/commands/send.ts";
import { relTime, truncate, usd, renderTable, secretPermsOk, parseClaudeHelp, pidAlive } from "../src/commands/_client.ts";
import type { Seat, CostsResponse } from "../shared/types.ts";

const TOKEN = "test-token";
let server: ReturnType<typeof Bun.serve>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastSend: any = null;

const NOW = Date.now();
const SEATS: Seat[] = [
  {
    id: "aaaa1111bbbb2222",
    pid: process.pid, // alive
    cwd: "/x",
    git_root: "/x",
    tty: "ttys004",
    summary: "impl+review of the linkcheck contract, definitely long enough to be truncated",
    role: "executor-1",
    model: "opus",
    profile: "peer",
    registered_at: new Date(NOW - 300_000).toISOString(),
    last_seen: new Date(NOW - 3_000).toISOString(),
  },
  {
    id: "cccc3333dddd4444",
    pid: 2 ** 30, // dead
    cwd: "/y",
    git_root: null,
    tty: null,
    summary: "orchestrator",
    role: "orch",
    model: "fable",
    profile: "full",
    registered_at: new Date(NOW).toISOString(),
    last_seen: new Date(NOW - 120_000).toISOString(),
  },
];
const COSTS: CostsResponse = {
  rows: [
    { seat_id: "aaaa1111bbbb2222", session_id: "s1", model: "opus", input: 1000, output: 2000, cache_write: 0, cache_read: 0, cost_usd: 2.16 },
    { seat_id: null, session_id: "s2", model: "sonnet", input: 500, output: 100, cache_write: 0, cache_read: 0, cost_usd: 0.42 },
  ],
  total_usd: 2.58,
};

beforeAll(async () => {
  const secretFile = `${process.env.TMPDIR ?? "/tmp"}/patrol-cli-test-${process.pid}.secret`;
  await Bun.write(secretFile, TOKEN);
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return new Response("ok");
      if (req.headers.get("x-patrol-token") !== TOKEN) return new Response("unauthorized", { status: 401 });
      const body = await req.json().catch(() => ({}));
      if (url.pathname === "/list-seats") return Response.json(SEATS);
      if (url.pathname === "/costs") return Response.json(COSTS);
      if (url.pathname === "/send-message") {
        lastSend = body;
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  process.env.CLAUDE_PATROL_PORT = String(server.port);
  process.env.CLAUDE_PATROL_SECRET_FILE = secretFile;
});

afterAll(() => server.stop(true));

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
  try {
    const code = await fn();
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = ol;
    console.error = oe;
  }
}

test("status renders the fleet board with per-seat spend + unattributed + total", async () => {
  const r = await capture(() => status([]));
  expect(r.code).toBe(0);
  expect(r.out).toContain("executor-1");
  expect(r.out).toContain("opus");
  expect(r.out).toContain("$2.16"); // attributed to executor-1
  expect(r.out).toContain("unattributed: $0.42");
  expect(r.out).toContain("total spend: $2.58");
  expect(r.out).toContain("…"); // long summary truncated
});

test("list prints short ids and roles", async () => {
  const r = await capture(() => list([]));
  expect(r.code).toBe(0);
  expect(r.out).toContain("aaaa1111"); // 8-char id slice
  expect(r.out).toContain("orch");
});

test("send posts the right envelope and returns 0", async () => {
  lastSend = null;
  const r = await capture(() => send(["aaaa1111bbbb2222", "hello", "world"]));
  expect(r.code).toBe(0);
  expect(r.out).toContain("sent to aaaa1111bbbb2222");
  expect(lastSend).toEqual({ from_id: "cli", to_id: "aaaa1111bbbb2222", text: "hello world" });
});

test("send without a message is a usage error (exit 2)", async () => {
  const r = await capture(() => send([]));
  expect(r.code).toBe(2);
  expect(r.err).toContain("usage:");
});

// ---- pure helpers ----

test("relTime buckets by magnitude", () => {
  const t = 1_000_000_000_000;
  expect(relTime(new Date(t - 3_000).toISOString(), t)).toBe("3s");
  expect(relTime(new Date(t - 120_000).toISOString(), t)).toBe("2m");
  expect(relTime(new Date(t - 7_200_000).toISOString(), t)).toBe("2h");
  expect(relTime(new Date(t - 172_800_000).toISOString(), t)).toBe("2d");
  expect(relTime("not-a-date", t)).toBe("?");
});

test("truncate adds an ellipsis only past the limit", () => {
  expect(truncate("abc", 5)).toBe("abc");
  expect(truncate("abcdef", 4)).toBe("abc…");
});

test("usd formats two decimals", () => {
  expect(usd(2.5)).toBe("$2.50");
  expect(usd(0)).toBe("$0.00");
});

test("renderTable right-aligns marked columns", () => {
  const out = renderTable(["A", "N"], [["x", "$1.00"], ["yy", "$10.00"]], new Set([1]));
  const lines = out.split("\n");
  // right-aligned money column ends flush
  expect(lines[1]?.endsWith(" $1.00")).toBe(true);
  expect(lines[2]?.endsWith("$10.00")).toBe(true);
});

test("secretPermsOk accepts 0600 only", () => {
  expect(secretPermsOk(0o600)).toBe(true);
  expect(secretPermsOk(0o100600)).toBe(true); // regular-file type bits ignored
  expect(secretPermsOk(0o644)).toBe(false);
  expect(secretPermsOk(0o660)).toBe(false);
});

test("parseClaudeHelp detects flags", () => {
  expect(parseClaudeHelp("opts: --bg  --tmux  --model")).toEqual({ bg: true, tmux: true });
  expect(parseClaudeHelp("only --tmux here")).toEqual({ bg: false, tmux: true });
});

test("pidAlive: self alive, absurd pid dead", () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(2 ** 30)).toBe(false);
});
