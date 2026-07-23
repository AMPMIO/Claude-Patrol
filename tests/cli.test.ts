import { test, expect, beforeAll, afterAll } from "bun:test";
import status from "../src/commands/status.ts";
import list from "../src/commands/list.ts";
import send from "../src/commands/send.ts";
import rename from "../src/commands/rename.ts";
import wait from "../src/commands/wait.ts";
import stats from "../src/commands/stats.ts";
import { bgPidState } from "../src/commands/down.ts";
import { relTime, truncate, usd, renderTable, secretPermsOk, parseClaudeHelp, pidAlive, resolveSeatTarget, seatLabel, BrokerError } from "../src/commands/_client.ts";
import type { Seat, CostsResponse, StatsResponse } from "../shared/types.ts";

const TOKEN = "test-token";
let server: ReturnType<typeof Bun.serve>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastSend: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastRename: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastWait: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastStats: any = null;
let costsFail = false; // when true the mock /costs returns 500, to prove status degrades
let statsDown = false; // when true the mock /stats returns 404, to prove stats refuses to fabricate

const NOW = Date.now();
const SEATS: Seat[] = [
  {
    // Real ids are 8 chars of [a-z0-9] (SLUG_RE/generateId) — the fixtures match, so
    // they model the id/handle namespace-overlap surface (MED-1).
    id: "aaaa1111",
    handle: "executor",
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
    id: "cccc3333",
    handle: "orch",
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
  {
    // Shares the "aaaa" id-prefix with seat 1 — used to prove an ambiguous prefix
    // ERRORS rather than resolving to the wrong seat.
    id: "aaaa2222",
    handle: "twin",
    pid: process.pid,
    cwd: "/z",
    git_root: null,
    tty: null,
    summary: "twin",
    role: "twin",
    model: "haiku",
    profile: "peer",
    registered_at: new Date(NOW).toISOString(),
    last_seen: new Date(NOW - 1_000).toISOString(),
  },
];
const COSTS: CostsResponse = {
  rows: [
    { seat_id: "aaaa1111", session_id: "s1", model: "opus", input: 1000, output: 2000, cache_write: 0, cache_read: 0, cost_usd: 2.16, billing_source: "subscription" },
    { seat_id: null, session_id: "s2", model: "sonnet", input: 500, output: 100, cache_write: 0, cache_read: 0, cost_usd: 0.42, billing_source: "agent-sdk" },
  ],
  total_usd: 2.58,
  by_source: { subscription: 2.16, "agent-sdk": 0.42 },
};
const STATS: StatsResponse = {
  seats: [
    {
      seat_id: "aaaa1111",
      role: "executor-1",
      model: "opus",
      live: true,
      bound_via: "token",
      notifications: 4,
      messages: 12,
      input: 10_000,
      output: 4_000,
      cache_write: 100,
      cache_read: 800,
      cost_usd: 1.2,
    },
    {
      seat_id: "cccc3333",
      role: "orch",
      model: "sonnet",
      live: false,
      bound_via: null,
      notifications: 0,
      messages: 0,
      input: 0,
      output: 0,
      cache_write: 0,
      cache_read: 0,
      cost_usd: 0.1,
    },
  ],
  totals: { notifications: 4, messages: 12, cost_usd: 1.3, unattributed_usd: 0.05 },
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await req.json().catch(() => ({}))) as any;
      if (url.pathname === "/list-seats") return Response.json(SEATS);
      if (url.pathname === "/costs") {
        if (costsFail) return new Response("costs scan wedged", { status: 500 });
        return Response.json(COSTS);
      }
      if (url.pathname === "/send-message") {
        lastSend = body;
        if (body.from_id === "garbage") return Response.json({ ok: false, error: 'from_id garbage is not a live seat (or "cli")' });
        if (body.to_id === "ghost") return Response.json({ ok: false, error: 'no live seat "ghost"' });
        return Response.json({ ok: true });
      }
      if (url.pathname === "/rename") {
        lastRename = body;
        // Emulate the broker's dedupe: "dupe" is taken -> suffix; else echo the name.
        return Response.json({ ok: true, handle: body.name === "dupe" ? "dupe-2" : body.name });
      }
      if (url.pathname === "/wait-for") {
        lastWait = body;
        // "done" in `until` => reached; otherwise emulate a timeout with a last state.
        return body.until.includes("done")
          ? Response.json({ reached: true, state: "done" })
          : Response.json({ reached: false, state: "working" });
      }
      if (url.pathname === "/stats") {
        if (statsDown) return new Response("not found", { status: 404 });
        lastStats = body;
        return Response.json(STATS);
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

test("status shows the three billing pools separately, with codex external as $—", async () => {
  const r = await capture(() => status([]));
  expect(r.code).toBe(0);
  // Three wallets on the by-wallet line, never summed into one.
  expect(r.out).toContain("subscription $2.16");
  expect(r.out).toContain("agent-sdk $0.42");
  expect(r.out).toContain("external $—"); // no ledger row for codex -> unknown, not a fabricated 0
  expect(r.out).toContain("total spend: $2.58");
});

test("list prints short ids and roles", async () => {
  const r = await capture(() => list([]));
  expect(r.code).toBe(0);
  expect(r.out).toContain("aaaa1111"); // 8-char id slice
  expect(r.out).toContain("orch");
});

test("send posts the right envelope and returns 0", async () => {
  lastSend = null;
  const r = await capture(() => send(["aaaa1111", "hello", "world"]));
  expect(r.code).toBe(0);
  expect(r.out).toContain("sent to aaaa1111");
  expect(lastSend).toEqual({ from_id: "cli", to_id: "aaaa1111", text: "hello world" });
});

test("wait resolves a handle, reaches the state, and exits 0", async () => {
  lastWait = null;
  const r = await capture(() => wait(["executor", "--until", "done,blocked", "--timeout", "5"]));
  expect(r.code).toBe(0);
  expect(lastWait).toEqual({ id: "cli", target: "aaaa1111", until: ["done", "blocked"], timeout_ms: 5000 });
  expect(r.out).toContain("executor reached state: done");
});

test("wait exits nonzero with the last state on timeout", async () => {
  const r = await capture(() => wait(["executor", "--until", "idle", "--timeout", "1"]));
  expect(r.code).toBe(1);
  expect(r.err).toContain("timed out after 1s (last state: working)");
});

test("wait without --until is a usage error (exit 2)", async () => {
  const r = await capture(() => wait(["executor"]));
  expect(r.code).toBe(2);
  expect(r.err).toContain("usage:");
});

test("send without a message is a usage error (exit 2)", async () => {
  const r = await capture(() => send([]));
  expect(r.code).toBe(2);
  expect(r.err).toContain("usage:");
});

// --- v0.2.4 handle resolution + display ---

test("resolveSeatTarget: exact handle wins; raw id + unique prefix resolve; ambiguous errors", async () => {
  expect(await resolveSeatTarget("executor")).toBe("aaaa1111"); // exact handle
  expect(await resolveSeatTarget("aaaa1111")).toBe("aaaa1111"); // raw full 8-char id (fallback unbroken)
  expect(await resolveSeatTarget("cccc")).toBe("cccc3333"); // unique id-prefix
  // "aaaa" prefixes BOTH seat 1 (aaaa1111) and the twin (aaaa2222) -> ambiguous -> error, not a wrong-seat pick.
  await expect(resolveSeatTarget("aaaa")).rejects.toBeInstanceOf(BrokerError);
  // A name matching nothing errors rather than silently hitting a live seat.
  await expect(resolveSeatTarget("nobody")).rejects.toThrow(/no live seat matches/);
});

test("send resolves a handle to the right id before posting", async () => {
  lastSend = null;
  const r = await capture(() => send(["executor", "ship", "it"]));
  expect(r.code).toBe(0);
  expect(lastSend).toEqual({ from_id: "cli", to_id: "aaaa1111", text: "ship it" });
});

test("status and list show the handle as the primary identifier plus the hex id", async () => {
  const s = await capture(() => status([]));
  expect(s.out).toContain("executor"); // handle in the SEAT column
  expect(s.out).toContain("aaaa1111"); // hex id still present as the secondary column
  const l = await capture(() => list([]));
  expect(l.out).toContain("executor");
  expect(l.out).toContain("aaaa1111");
  // seatLabel falls back to the short id when a seat has no handle.
  expect(seatLabel({ id: "abcd1234ffff0000" })).toBe("abcd1234");
  expect(seatLabel({ id: "abcd1234ffff0000", handle: "boss" })).toBe("boss");
});

test("rename resolves the target and prints the broker-assigned handle (deduped)", async () => {
  lastRename = null;
  const ok = await capture(() => rename(["executor", "captain"]));
  expect(ok.code).toBe(0);
  expect(lastRename).toEqual({ id: "aaaa1111", name: "captain" });
  expect(ok.out).toContain("renamed to captain");
  // A name the broker had to adjust surfaces the actual assigned handle.
  const adj = await capture(() => rename(["executor", "dupe"]));
  expect(adj.out).toContain("renamed to dupe-2");
});

test("send to an unknown target fails client-side (exit 1, no false 'sent')", async () => {
  // "ghost" matches no handle or id, so resolveSeatTarget rejects it BEFORE any post —
  // a typo can never silently hit a live seat.
  const r = await capture(() => send(["ghost", "hello"]));
  expect(r.code).toBe(1);
  expect(r.err).toContain('no live seat matches "ghost"');
  expect(r.out).not.toContain("sent to");
});

test("status renders the board even when /costs fails", async () => {
  costsFail = true;
  try {
    const r = await capture(() => status([]));
    expect(r.code).toBe(0);
    expect(r.out).toContain("executor-1"); // board still rendered
    expect(r.out).toContain("spend unavailable"); // spend degraded, not hidden
    expect(r.out).not.toContain("total spend");
  } finally {
    costsFail = false;
  }
});

test("stats renders per-seat table with coalescing ratio, cache ratio, and the saved-wakeups line", async () => {
  const r = await capture(() => stats([]));
  expect(r.code).toBe(0);
  expect(r.out).toContain("executor-1");
  expect(r.out).toContain("token"); // bound_via
  expect(r.out).toContain("3.0"); // 12 msgs / 4 wakes
  expect(r.out).toContain("8.0"); // 800 cache_read / 100 cache_write
  expect(r.out).toContain("$1.20");
  expect(r.out).toContain("-"); // dead seat: 0 wakes -> msg/wake "-"
  expect(r.out).toContain("$1.30"); // totals spend
  expect(r.out).toContain("$0.05"); // unattributed
  expect(r.out).toContain("coalescing saved ~8 wake-ups (12 messages arrived in 4 notifications)");
});

test("stats --json emits parseable JSON deep-equal to the fixture", async () => {
  const r = await capture(() => stats(["--json"]));
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toEqual(STATS);
});

test("stats: broker route missing -> exit 1, stderr non-empty, no fabricated zeros", async () => {
  statsDown = true;
  try {
    const r = await capture(() => stats([]));
    expect(r.code).toBe(1);
    expect(r.err.length).toBeGreaterThan(0);
    expect(r.out).toBe("");
  } finally {
    statsDown = false;
  }
});

test("stats --since passes through to the /stats request body", async () => {
  lastStats = null;
  await capture(() => stats(["--since", "2026-07-01T00:00:00Z"]));
  expect(lastStats?.since).toBe("2026-07-01T00:00:00Z");
});

test("bgPidState: live non-claude pid is 'other', absent pid is 'gone'", () => {
  const proc = Bun.spawn(["sleep", "30"]);
  try {
    expect(bgPidState(proc.pid)).toBe("other"); // alive, argv has no 'claude'
    expect(bgPidState(2 ** 30)).toBe("gone"); // no such process
  } finally {
    proc.kill();
  }
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
