/**
 * WP-N: port claims, file claims, seat state, and billing_source pool split —
 * exercised against a REAL broker subprocess (own port + temp DB) so the
 * db.transaction atomicity, endSeat reaping, and cross-restart persistence are
 * tested end-to-end, not mocked.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 17901;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "patrol-claims-"));
const SECRET_FILE = join(dir, "secret");
const DB_FILE = join(dir, "test.db");
const PROJECTS_ROOT = join(dir, "projects");

let broker: ReturnType<typeof Bun.spawn>;
let TOKEN = "";

const ENV = {
  ...process.env,
  CLAUDE_PATROL_PORT: String(PORT),
  CLAUDE_PATROL_DB: DB_FILE,
  CLAUDE_PATROL_SECRET_FILE: SECRET_FILE,
  CLAUDE_PATROL_PROJECTS_ROOT: PROJECTS_ROOT,
  CLAUDE_PATROL_INDEX_INTERVAL_MS: "80",
  CLAUDE_PATROL_TOKEN_SCAN_CAP: "3",
  CLAUDE_PATROL_PORT_RANGE_LO: "9000",
  CLAUDE_PATROL_PORT_RANGE_HI: "9099",
};

async function spawnBroker(): Promise<void> {
  broker = Bun.spawn(["bun", new URL("../src/broker.ts", import.meta.url).pathname], { env: ENV, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${URL_BASE}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  TOKEN = (await Bun.file(SECRET_FILE).text()).trim();
}

async function post(path: string, body: unknown, token = TOKEN) {
  return fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-patrol-token": token },
    body: JSON.stringify(body),
  });
}

// Each seat needs a DISTINCT, alive pid: the broker replaces a same-pid seat on
// re-register (retiring its claims), and liveSeat authz requires the pid be alive.
// Real sleeper subprocesses give both — distinct real pids that stay alive for the
// test, reaped in afterAll.
const sleepers: ReturnType<typeof Bun.spawn>[] = [];
function alivePid(): number {
  const p = Bun.spawn(["sleep", "120"], { stdio: ["ignore", "ignore", "ignore"] });
  sleepers.push(p);
  return p.pid;
}

async function register(over: Record<string, unknown> = {}): Promise<string> {
  const res = await post("/register", { pid: alivePid(), cwd: "/tmp/claims-seat", git_root: null, tty: null, summary: "", role: "worker", ...over });
  return ((await res.json()) as { id: string }).id;
}

async function listSeats() {
  return (await (await post("/list-seats", { scope: "machine", cwd: "/", git_root: null })).json()) as Array<{ id: string; state?: string }>;
}

beforeAll(async () => {
  mkdirSync(PROJECTS_ROOT, { recursive: true });
  await spawnBroker();
});
afterAll(() => {
  broker.kill();
  for (const s of sleepers) s.kill();
  rmSync(dir, { recursive: true, force: true });
});

// --- Section D: seat state ---

test("set-state round-trips into /list-seats; can't set a non-live seat; unset reads absent", async () => {
  const a = await register();
  const b = await register();
  // A never-set seat has no state (reads "unknown" downstream).
  expect((await listSeats()).find((s) => s.id === b)?.state ?? null).toBeNull();

  expect((await (await post("/set-state", { id: a, state: "working" })).json())).toEqual({ ok: true });
  const seats = await listSeats();
  expect(seats.find((s) => s.id === a)?.state).toBe("working"); // A updated
  expect(seats.find((s) => s.id === b)?.state ?? null).toBeNull(); // B untouched — no cross-seat bleed

  // A dead / unknown seat id is rejected (scope-by-live-id guard).
  const dead = await post("/set-state", { id: "zzzzzzzz", state: "done" });
  expect(((await dead.json()) as { ok: boolean }).ok).toBe(false);
  // Invalid state value is a 400.
  expect((await post("/set-state", { id: a, state: "bogus" })).status).toBe(400);
});

// --- Feature A: port claims ---

test("claim-port allocates distinct ports; concurrent claims never double-grant", async () => {
  const seat = await register();
  const first = (await (await post("/claim-port", { id: seat, count: 3 })).json()) as { ports: number[] };
  expect(first.ports).toHaveLength(3);
  expect(new Set(first.ports).size).toBe(3);
  first.ports.forEach((p) => expect(p).toBeGreaterThanOrEqual(9000));

  // 8 concurrent single-port claims: the sync db.transaction must hand out 8 DISTINCT
  // ports (no select-then-await gap), none colliding with the 3 already held.
  const seats = await Promise.all(Array.from({ length: 8 }, () => register()));
  const results = await Promise.all(seats.map((s) => post("/claim-port", { id: s, count: 1 }).then((r) => r.json() as Promise<{ ports: number[] }>)));
  const all = [...first.ports, ...results.flatMap((r) => r.ports)];
  expect(new Set(all).size).toBe(all.length); // every allocated port is unique
});

test("claim-port persists in the db and survives a broker restart (no double-allocation)", async () => {
  const seat = await register();
  const before = (await (await post("/claim-port", { id: seat, count: 2 })).json()) as { ports: number[] };

  // Simulated restart: kill the broker, respawn on the SAME db. An in-process Set
  // would forget the allocation here; the persisted port_claims table must not.
  broker.kill();
  await broker.exited;
  await spawnBroker();

  // The seat's pid is this live process, so its row + claims survived the restart's
  // stale-sweep. A fresh claim must avoid the still-held ports.
  const seat2 = await register();
  const after = (await (await post("/claim-port", { id: seat2, count: 2 })).json()) as { ports: number[] };
  for (const p of after.ports) expect(before.ports).not.toContain(p);
});

test("claim-port and path claims are reaped when the seat dies (endSeat)", async () => {
  // Claiming needs a LIVE seat (authz), so claim first, then retire the seat via
  // /unregister — which calls endSeat, the ONE removal path all three reap triggers
  // (stale sweep, list-seats lazy drop, unregister) funnel through. If endSeat reaps,
  // all three do. A claim outliving its holder = a port allocated forever.
  const seat = await register();
  const ports = (await (await post("/claim-port", { id: seat, count: 2 })).json()) as { ports: number[] };
  expect(ports.ports).toHaveLength(2);
  const ghostPath = join(dir, "ghost-file");
  expect(((await (await post("/claim-path", { id: seat, paths: [ghostPath] })).json()) as { granted: string[] }).granted).toHaveLength(1);

  // White-box: the claims are PERSISTED rows keyed by owner_id before the seat dies.
  const readOwned = (table: string, owner: string): number => {
    const rdb = new Database(DB_FILE, { readonly: true });
    try {
      return (rdb.query(`SELECT COUNT(*) AS c FROM ${table} WHERE owner_id = ?`).get(owner) as { c: number }).c;
    } finally {
      rdb.close();
    }
  };
  expect(readOwned("port_claims", seat)).toBe(2);
  expect(readOwned("path_claims", seat)).toBe(1);

  await post("/unregister", { id: seat }); // endSeat -> reap its port + path claims

  // Both claim kinds reaped: no port/path row outlives its holder.
  expect(readOwned("port_claims", seat)).toBe(0);
  expect(readOwned("path_claims", seat)).toBe(0);
  const claims = (await (await post("/list-claims", {})).json()) as Array<{ owner_id: string }>;
  expect(claims.some((c) => c.owner_id === seat)).toBe(false);
});

// --- Feature B: file claims ---

test("claim-path: first wins, a second owner is denied with the holder; same owner is idempotent", async () => {
  const a = await register({ role: "alpha" });
  const b = await register({ role: "beta" });
  const p = join(dir, "contended.txt");

  const g = (await (await post("/claim-path", { id: a, paths: [p] })).json()) as { granted: string[]; denied: unknown[] };
  expect(g.granted).toHaveLength(1);
  expect(g.denied).toHaveLength(0);

  // b is DENIED and told the current holder (advisory — no theft).
  const d = (await (await post("/claim-path", { id: b, paths: [p] })).json()) as { granted: string[]; denied: Array<{ owner_id: string; owner_role: string | null }> };
  expect(d.granted).toHaveLength(0);
  expect(d.denied[0]!.owner_id).toBe(a);
  expect(d.denied[0]!.owner_role).toBe("alpha");

  // a re-claiming its own path is idempotent (granted, not denied).
  const again = (await (await post("/claim-path", { id: a, paths: [p] })).json()) as { granted: string[]; denied: unknown[] };
  expect(again.granted).toHaveLength(1);
  expect(again.denied).toHaveLength(0);
});

test("concurrent claim of one path grants exactly one owner", async () => {
  const seats = await Promise.all(Array.from({ length: 6 }, () => register()));
  const p = join(dir, "race.txt");
  const results = await Promise.all(seats.map((s) => post("/claim-path", { id: s, paths: [p] }).then((r) => r.json() as Promise<{ granted: string[] }>)));
  const winners = results.filter((r) => r.granted.length === 1);
  expect(winners).toHaveLength(1); // exactly one seat holds the path
});

test("release: only your own claims; releasing another's is a no-op; idempotent", async () => {
  const a = await register();
  const b = await register();
  const pa = join(dir, "a-owned.txt");
  await post("/claim-path", { id: a, paths: [pa] });

  // b cannot release a path it doesn't own — the claim survives.
  await post("/release-claims", { id: b, paths: [pa] });
  let claims: Array<{ path: string; owner_id: string }> = (await (await post("/list-claims", {})).json()) as Array<{ path: string; owner_id: string }>;
  expect(claims.some((c) => c.path.endsWith("a-owned.txt") && c.owner_id === a)).toBe(true);

  // a releases its own — gone. Releasing again is idempotent (no error).
  expect(((await (await post("/release-claims", { id: a, paths: [pa] })).json()) as { ok: boolean }).ok).toBe(true);
  expect(((await (await post("/release-claims", { id: a, paths: [pa] })).json()) as { ok: boolean }).ok).toBe(true);
  claims = (await (await post("/list-claims", {})).json()) as Array<{ path: string; owner_id: string }>;
  expect(claims.some((c) => c.path.endsWith("a-owned.txt"))).toBe(false);
});

// --- Feature C: billing_source pool split ---

test("by_source splits the ledger into subscription vs agent-sdk wallets", async () => {
  // Two sessions with the SAME window: one sdk-cli (agent-sdk wallet), one cli
  // (subscription). The ledger indexer must tag each and /costs must split them.
  // A live seat in this project dir makes the indexer "interested" in it (it scopes
  // scanning to fleet project dirs). cwd /tmp/billing encodes to the -tmp-billing dir.
  await register({ cwd: "/tmp/billing" });
  const proj = join(PROJECTS_ROOT, "-tmp-billing");
  mkdirSync(proj, { recursive: true });
  const asst = (sid: string, ep: string | null, i: number, o: number) =>
    JSON.stringify({ type: "assistant", sessionId: sid, timestamp: "2026-07-23T10:00:00Z", ...(ep ? { entrypoint: ep } : {}), message: { id: `${sid}-1`, model: "claude-opus-4-8", usage: { input_tokens: i, output_tokens: o } } }) + "\n";
  writeFileSync(join(proj, "bill-sdk.jsonl"), asst("bill-sdk", "sdk-cli", 1000, 500));
  writeFileSync(join(proj, "bill-sub.jsonl"), asst("bill-sub", "cli", 2000, 300));

  // Poll the ledger-backed /costs until both fixture sessions land.
  let costs: { total_usd: number; by_source?: Record<string, number>; rows: Array<{ session_id: string; billing_source?: string }> } = { total_usd: 0, rows: [] };
  for (let i = 0; i < 60; i++) {
    costs = (await (await post("/costs", { since: "2026-07-23T00:00:00Z", until: "2026-07-23T23:59:59Z" })).json()) as typeof costs;
    if (costs.rows.some((r) => r.session_id === "bill-sdk") && costs.rows.some((r) => r.session_id === "bill-sub")) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(costs.rows.find((r) => r.session_id === "bill-sdk")?.billing_source).toBe("agent-sdk");
  expect(costs.rows.find((r) => r.session_id === "bill-sub")?.billing_source).toBe("subscription");
  expect(costs.by_source).toBeDefined();
  expect(costs.by_source!["agent-sdk"]).toBeGreaterThan(0);
  expect(costs.by_source!["subscription"]).toBeGreaterThan(0);
  // No codex transcript => no "external" wallet in the ledger.
  expect(costs.by_source!["external"]).toBeUndefined();
  // Columns sum to the displayed total (no independent-rounding gap).
  const sum = Object.values(costs.by_source!).reduce((acc, v) => acc + v, 0);
  expect(Math.round(sum * 1e4) / 1e4).toBe(costs.total_usd);
});
