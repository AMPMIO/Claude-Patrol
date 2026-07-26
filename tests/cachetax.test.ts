/**
 * v0.3 cache re-encode tax ("cache tax").
 *
 * Two layers, tested separately on purpose:
 *  1. the classifier, as a pure function — the rule itself, no files, no broker;
 *  2. the whole indexer path, end to end — fixture jsonl -> broker tick -> ledger
 *     -> /costs, with the dollar figure computed BY HAND in the test so a pricing
 *     change can't quietly redefine what the number means.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyCacheRebuild,
  classifyCacheRebuilds,
  computeCosts,
  projectDirName,
  CACHE_REBUILD_FLOOR_TOKENS as FLOOR,
} from "../src/costs.ts";
import status from "../src/commands/status.ts";
import type { CostsResponse } from "../shared/types.ts";

// --- 1. the classifier, pure ------------------------------------------------

test("first-time prefix creation is NOT a rebuild", () => {
  // A big write with nothing read back yet is a prefix being born. Normal, not a tax.
  expect(classifyCacheRebuild(50_000, 0, 0).rebuild).toBe(false);
});

test("a big write AFTER an established read IS a rebuild", () => {
  expect(classifyCacheRebuild(50_000, 0, 40_000).rebuild).toBe(true);
});

test("a small write is not a rebuild, however established the prefix", () => {
  expect(classifyCacheRebuild(FLOOR - 1, 0, 1_000_000).rebuild).toBe(false);
});

test("a big write with no prior read is not a rebuild", () => {
  // The whole point of condition (b): without it, every session's first turn
  // would be taxed for creating the cache it is supposed to create.
  expect(classifyCacheRebuild(1_000_000, 0, 0).rebuild).toBe(false);
});

test("the record's OWN read does not establish the prefix for itself", () => {
  // "already shown a substantial read" means EARLIER. Folding this record's own
  // read in first would let one record both establish and violate the prefix.
  expect(classifyCacheRebuild(50_000, 90_000, 0).rebuild).toBe(false);
  // ...but it does count for the NEXT record.
  expect(classifyCacheRebuild(50_000, 90_000, 0).maxCacheRead).toBe(90_000);
});

test("both halves sit exactly on the floor", () => {
  expect(classifyCacheRebuild(FLOOR, 0, FLOOR).rebuild).toBe(true);
  expect(classifyCacheRebuild(FLOOR, 0, FLOOR - 1).rebuild).toBe(false);
  expect(classifyCacheRebuild(FLOOR - 1, 0, FLOOR).rebuild).toBe(false);
});

test("multiple rebuilds in one session count separately", () => {
  const r = classifyCacheRebuilds([
    { cache_write: 50_000, cache_read: 0 }, // create: not a rebuild
    { cache_write: 800, cache_read: 50_000 }, // reads it back cheap
    { cache_write: 60_000, cache_read: 0 }, // REBUILD
    { cache_write: 5_000, cache_read: 60_000 }, // small write
    { cache_write: 70_000, cache_read: 0 }, // REBUILD
  ]);
  expect(r.rebuilds).toBe(2);
  expect(r.rebuild_tokens).toBe(130_000);
  expect(r.maxCacheRead).toBe(60_000);
});

test("carried state lets a session be classified across several batches", () => {
  // This is what the broker's incremental indexer does: the same session's records
  // arrive a few at a time, so the running max has to survive between calls.
  const first = classifyCacheRebuilds([{ cache_write: 50_000, cache_read: 0 }, { cache_write: 100, cache_read: 50_000 }]);
  expect(first.rebuilds).toBe(0);
  const second = classifyCacheRebuilds([{ cache_write: 60_000, cache_read: 0 }], first.maxCacheRead);
  expect(second.rebuilds).toBe(1);
  // Without the carry, the same batch on its own sees no established prefix.
  expect(classifyCacheRebuilds([{ cache_write: 60_000, cache_read: 0 }]).rebuilds).toBe(0);
});

// --- 2. the fixture, end to end through the indexer -------------------------

const PORT = 17910;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "patrol-cachetax-"));
const DB_FILE = join(dir, "test.db");
const SECRET_FILE = join(dir, "secret");
const PROJECTS_ROOT = join(dir, "projects");
const CWD = join(dir, "repo");
let broker: ReturnType<typeof Bun.spawn>;
let TOKEN = "";

// Hand-computed expectations. PRICES index 2 is $/MTok cache_write:
//   opus  6.25  ->  130_000 tok = 0.130 MTok * 6.25 = $0.8125
//   haiku 1.25  ->   40_000 tok = 0.040 MTok * 1.25 = $0.05
//   total                                             $0.8625
const EXPECT_REBUILDS = 3;
const EXPECT_TOKENS = 170_000;
const EXPECT_TAX_USD = 0.8625;

function rec(session: string, id: string, model: string, cw: number, cr: number, ts: string): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: session,
    timestamp: ts,
    message: { id, model, usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: cw, cache_read_input_tokens: cr } },
  });
}

async function post(path: string, body: unknown, token = TOKEN): Promise<Response> {
  return fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-patrol-token": token },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const projDir = join(PROJECTS_ROOT, projectDirName(CWD));
  mkdirSync(projDir, { recursive: true });
  mkdirSync(CWD, { recursive: true });

  // opus session: create, read, REBUILD, small write, REBUILD
  writeFileSync(
    join(projDir, "taxA.jsonl"),
    [
      rec("taxA", "a1", "claude-opus-4-8", 50_000, 0, "2026-07-08T10:00:00Z"),
      rec("taxA", "a2", "claude-opus-4-8", 800, 50_000, "2026-07-08T10:05:00Z"),
      rec("taxA", "a3", "claude-opus-4-8", 60_000, 0, "2026-07-08T10:20:00Z"),
      rec("taxA", "a4", "claude-opus-4-8", 5_000, 60_000, "2026-07-08T10:25:00Z"),
      rec("taxA", "a5", "claude-opus-4-8", 70_000, 0, "2026-07-08T11:40:00Z"), // a different hour bucket
    ].join("\n") + "\n"
  );
  // haiku session: proves the tax is summed per model at that model's rate, not averaged
  writeFileSync(
    join(projDir, "taxB.jsonl"),
    [
      rec("taxB", "b1", "claude-haiku-4-5-20251001", 20_000, 0, "2026-07-08T10:00:00Z"),
      rec("taxB", "b2", "claude-haiku-4-5-20251001", 500, 30_000, "2026-07-08T10:05:00Z"),
      rec("taxB", "b3", "claude-haiku-4-5-20251001", 40_000, 0, "2026-07-08T10:30:00Z"),
    ].join("\n") + "\n"
  );

  broker = Bun.spawn(["bun", new URL("../src/broker.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      CLAUDE_PATROL_PORT: String(PORT),
      CLAUDE_PATROL_DB: DB_FILE,
      CLAUDE_PATROL_SECRET_FILE: SECRET_FILE,
      CLAUDE_PATROL_PROJECTS_ROOT: PROJECTS_ROOT,
      CLAUDE_PATROL_INDEX_INTERVAL_MS: "80",
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
  // indexTick skips everything when no seat is live, and only walks project dirs a
  // seat sits in — so the fixture is invisible until one registers here.
  const reg = await post("/register", { pid: process.pid, cwd: CWD, git_root: null, tty: null, summary: "cache tax fixture", role: "lead", model: "opus" });
  if (!reg.ok) throw new Error(`fixture seat failed to register: ${reg.status} ${await reg.text()}`);
});

afterAll(() => {
  broker.kill();
  rmSync(dir, { recursive: true, force: true });
});

async function pollCosts(until: (c: CostsResponse) => boolean, tries = 60): Promise<CostsResponse> {
  let last = { rows: [], total_usd: 0 } as CostsResponse;
  for (let i = 0; i < tries; i++) {
    last = (await (await post("/costs", { since: "2026-07-08T00:00:00Z", until: "2026-07-08T23:59:59Z" })).json()) as CostsResponse;
    if (until(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

test("rebuild counters survive the indexer and land on /costs rows", async () => {
  const costs = await pollCosts((c) => (c.cache_tax?.rebuilds ?? 0) >= EXPECT_REBUILDS);
  const a = costs.rows.find((r) => r.session_id === "taxA");
  const b = costs.rows.find((r) => r.session_id === "taxB");
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  // taxA's two rebuilds sit in DIFFERENT hour buckets, so this also proves the
  // per-bucket ledger rows collapse back into one per-session total.
  expect(a!.cache_rebuilds).toBe(2);
  expect(a!.cache_rebuild_tokens).toBe(130_000);
  expect(b!.cache_rebuilds).toBe(1);
  expect(b!.cache_rebuild_tokens).toBe(40_000);
});

test("cache_tax sums across models at each model's own cache-write rate", async () => {
  const costs = await pollCosts((c) => (c.cache_tax?.rebuilds ?? 0) >= EXPECT_REBUILDS);
  expect(costs.cache_tax).toBeDefined();
  expect(costs.cache_tax!.rebuilds).toBe(EXPECT_REBUILDS);
  expect(costs.cache_tax!.rebuild_tokens).toBe(EXPECT_TOKENS);
  // $0.8125 (opus) + $0.05 (haiku). Averaging the two rates would give $0.6375 —
  // this assertion is what stops that.
  expect(costs.cache_tax!.tax_usd).toBeCloseTo(EXPECT_TAX_USD, 4);
});

test("a second index tick does not double-count rebuilds", async () => {
  // seen_msgs dedupe covers tokens; the rebuild counters ride the same path, so a
  // re-tick over an unchanged file must not add to them either.
  const first = await pollCosts((c) => (c.cache_tax?.rebuilds ?? 0) >= EXPECT_REBUILDS);
  await new Promise((r) => setTimeout(r, 300)); // several ticks at 80ms
  const second = await pollCosts(() => true);
  expect(second.cache_tax!.rebuilds).toBe(first.cache_tax!.rebuilds);
  expect(second.cache_tax!.rebuild_tokens).toBe(first.cache_tax!.rebuild_tokens);
});

test("computeCosts (the full-walk reference path) agrees with the ledger", async () => {
  const c = computeCosts({ projectsRoot: PROJECTS_ROOT, since: "2026-07-08T00:00:00Z", until: "2026-07-08T23:59:59Z" });
  expect(c.cache_tax!.rebuilds).toBe(EXPECT_REBUILDS);
  expect(c.cache_tax!.rebuild_tokens).toBe(EXPECT_TOKENS);
  expect(c.cache_tax!.tax_usd).toBeCloseTo(EXPECT_TAX_USD, 4);
});

// --- 3. the readout ---------------------------------------------------------

// A stub broker, so the readout is tested on exactly the payloads it must handle
// rather than on whatever the fixture happens to produce.
const stubDir = mkdtempSync(join(tmpdir(), "patrol-cachetax-cli-"));
const stubSecret = join(stubDir, "secret");
let stubTax: CostsResponse["cache_tax"];
let stub: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  writeFileSync(stubSecret, "stubtoken\n", { mode: 0o600 });
  stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/list-seats") return Response.json([]);
      if (url.pathname === "/worktree-list") return Response.json([]);
      if (url.pathname === "/costs") {
        return Response.json({ rows: [], total_usd: 0, by_source: {}, cache_tax: stubTax } satisfies CostsResponse);
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  stub.stop(true);
  rmSync(stubDir, { recursive: true, force: true });
});

// Point the CLI at the stub for exactly the duration of one call. These env vars are
// process-global and `bun test` shares one process across files, so leaving them set
// redirects ANOTHER file's CLI subprocesses at this stub (it did: 50 worktree failures).
async function capture(fn: () => Promise<number>): Promise<string> {
  const out: string[] = [];
  const ol = console.log;
  const prevPort = process.env.CLAUDE_PATROL_PORT;
  const prevSecret = process.env.CLAUDE_PATROL_SECRET_FILE;
  process.env.CLAUDE_PATROL_PORT = String(stub.port);
  process.env.CLAUDE_PATROL_SECRET_FILE = stubSecret;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  try {
    await fn();
    return out.join("\n");
  } finally {
    console.log = ol;
    if (prevPort === undefined) delete process.env.CLAUDE_PATROL_PORT;
    else process.env.CLAUDE_PATROL_PORT = prevPort;
    if (prevSecret === undefined) delete process.env.CLAUDE_PATROL_SECRET_FILE;
    else process.env.CLAUDE_PATROL_SECRET_FILE = prevSecret;
  }
}

test("a zero-tax fleet prints nothing", async () => {
  stubTax = { rebuilds: 0, rebuild_tokens: 0, tax_usd: 0 };
  expect(await capture(() => status([]))).not.toContain("cache tax");
});

test("a broker with no cache_tax at all prints nothing", async () => {
  // An older broker against a newer CLI: the field is optional and absent.
  stubTax = undefined;
  expect(await capture(() => status([]))).not.toContain("cache tax");
});

test("a taxed fleet gets one fleet-level line, marked as a heuristic", async () => {
  stubTax = { rebuilds: 3, rebuild_tokens: 412_000, tax_usd: 1.03 };
  const out = await capture(() => status([]));
  expect(out).toContain("cache tax:");
  expect(out).toContain("3 rebuilds");
  expect(out).toContain("412k tokens");
  expect(out).toContain("$1.03");
  // Never presented as money lost; always flagged as inferred.
  expect(out).toContain("heuristic");
  expect(out).not.toContain("lost");
});
