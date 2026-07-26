/**
 * v0.3 broker identity: per-seat capability tokens, fleet scoping, crash redelivery.
 *
 * The thing under test is a REFUSAL, so most of these assert a status code rather than a
 * payload: seat A presenting its own token on seat B's routes must be turned away, and the
 * same request with the operator's shared secret must still go through. A test that only
 * checked the happy path would pass against the broken code this replaces.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 17911;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "patrol-identity-"));
const SECRET_FILE = join(dir, "secret");
const DB_FILE = join(dir, "test.db");

let broker: ReturnType<typeof Bun.spawn>;
let SECRET: string;
// Live processes to hang seats off: two seats can never share a pid (a same-pid register
// retires the previous seat), so a multi-seat test needs genuinely distinct live pids.
const spawned: ReturnType<typeof Bun.spawn>[] = [];

async function post(path: string, body: unknown, token = SECRET) {
  return fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-patrol-token": token },
    body: JSON.stringify(body),
  });
}

function livePid(): number {
  const p = Bun.spawn(["sleep", "120"], { stdio: ["ignore", "ignore", "ignore"] });
  spawned.push(p);
  return p.pid;
}

// A pid in the valid range that no process holds — a seat registered on one is "crashed" the
// moment the next sweep looks at it.
let deadPidSeq = 2_000_000_000;
const deadPid = () => deadPidSeq++;

type Reg = { id: string; capability_token?: string };
async function register(extra: Record<string, unknown> = {}): Promise<Reg> {
  const res = await post("/register", {
    pid: livePid(), cwd: "/tmp/identity", git_root: null, tty: null, summary: "s",
    role: null, model: null, ...extra,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Reg;
}

// The sweep interval is 30s, far longer than this suite runs; /list-seats is the in-test
// trigger that runs the full endSeat path over dead pids.
const sweep = () => post("/list-seats", { scope: "machine", cwd: "/", git_root: null });

function peekDb<T>(fn: (db: Database) => T): T {
  const db = new Database(DB_FILE, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  broker = Bun.spawn(["bun", new URL("../src/broker.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      CLAUDE_PATROL_PORT: String(PORT),
      CLAUDE_PATROL_DB: DB_FILE,
      CLAUDE_PATROL_SECRET_FILE: SECRET_FILE,
      CLAUDE_PATROL_PROJECTS_ROOT: join(dir, "projects"),
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
  for (const p of spawned) p.kill();
  rmSync(dir, { recursive: true, force: true });
});

// --- Task A: capability tokens ---

describe("capability tokens", () => {
  test("register mints a cps- token and returns it exactly once", async () => {
    const a = await register();
    expect(a.capability_token).toMatch(/^cps-[0-9a-f]{32}$/);
  });

  test("the token is stored HASHED — the db never holds the value handed to the seat", async () => {
    const a = await register();
    const token = a.capability_token!;
    const rows = peekDb((db) => db.query("SELECT token_hash, seat_id FROM seat_tokens WHERE seat_id = ?").all(a.id)) as {
      token_hash: string; seat_id: string;
    }[];
    expect(rows).toHaveLength(1);
    // The stored value is NOT the token: a reader of the db file cannot act as this seat.
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(rows[0]!.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    // And no column anywhere in that table carries the plaintext.
    const anyPlaintext = peekDb((db) => db.query("SELECT 1 FROM seat_tokens WHERE token_hash = ?").get(token));
    expect(anyPlaintext).toBeNull();
  });

  test("seat A's token is REFUSED on every seat-owned route of seat B", async () => {
    const a = await register();
    const b = await register();
    const tok = a.capability_token!;

    const foreign: Array<[string, unknown]> = [
      ["/set-state", { id: b.id, state: "working" }],
      ["/set-summary", { id: b.id, summary: "hijacked" }],
      ["/ack", { id: b.id, message_ids: [1] }],
      ["/poll-messages", { id: b.id }],
      ["/release-claims", { id: b.id }],
      ["/worktree-remove", { id: b.id, path: "/tmp/identity" }],
      ["/claim-port", { id: b.id, count: 1 }],
      ["/claim-path", { id: b.id, paths: ["/tmp/identity/x"] }],
      ["/heartbeat", { id: b.id }],
      ["/rename", { id: b.id, name: "stolen" }],
      ["/ask", { id: b.id, text: "who am i" }],
      ["/unregister", { id: b.id }],
    ];
    for (const [path, body] of foreign) {
      const res = await post(path, body, tok);
      expect(`${path}:${res.status}`).toBe(`${path}:403`);
    }
    // B is untouched: no state was set, and it is still registered.
    const seats = (await (await sweep()).json()) as Array<{ id: string; state?: string; handle?: string }>;
    const bRow = seats.find((s) => s.id === b.id);
    expect(bRow).toBeDefined();
    expect(bRow!.state ?? null).toBeNull();
    expect(bRow!.handle).not.toBe("stolen");
  });

  test("seat A's token is ACCEPTED on the same routes for itself", async () => {
    const a = await register();
    const tok = a.capability_token!;

    const own: Array<[string, unknown]> = [
      ["/set-state", { id: a.id, state: "working" }],
      ["/set-summary", { id: a.id, summary: "mine" }],
      ["/poll-messages", { id: a.id }],
      ["/ack", { id: a.id, message_ids: [1] }],
      ["/release-claims", { id: a.id }],
      ["/worktree-remove", { id: a.id, path: "/tmp/identity" }],
      ["/heartbeat", { id: a.id }],
    ];
    for (const [path, body] of own) {
      const res = await post(path, body, tok);
      expect(`${path}:${res.status}`).toBe(`${path}:200`);
    }
    const seats = (await (await sweep()).json()) as Array<{ id: string; state?: string; summary: string }>;
    const row = seats.find((s) => s.id === a.id)!;
    expect(row.state).toBe("working");
    expect(row.summary).toBe("mine");
  });

  test("/unregister by PID cannot be used to dereg another seat", async () => {
    const a = await register();
    const bPid = livePid();
    const b = await post("/register", {
      pid: bPid, cwd: "/tmp/identity", git_root: null, tty: null, summary: "b", role: null, model: null,
    });
    const bId = ((await b.json()) as Reg).id;

    // The pid form resolves to B, so A's token must be refused on it — otherwise the identity
    // check would be trivially bypassable by naming a pid instead of an id.
    const res = await post("/unregister", { pid: bPid }, a.capability_token!);
    expect(res.status).toBe(403);
    const seats = (await (await sweep()).json()) as Array<{ id: string }>;
    expect(seats.some((s) => s.id === bId)).toBe(true);
  });

  test("/send-message at seat scope can only speak AS the token's seat", async () => {
    const a = await register();
    const b = await register();
    const forged = await post("/send-message", { from_id: b.id, to_id: a.id, text: "from B, allegedly" }, a.capability_token!);
    expect(forged.status).toBe(403);
    const own = await post("/send-message", { from_id: a.id, to_id: b.id, text: "genuinely from A" }, a.capability_token!);
    expect(own.status).toBe(200);
    expect(((await own.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("a seat token is default-DENIED on routes outside its lane", async () => {
    const a = await register();
    for (const [path, body] of [
      ["/register", { pid: livePid(), cwd: "/tmp/x", git_root: null, tty: null, summary: "s" }],
      ["/dash-token", {}],
      ["/costs", {}],
      ["/stats", {}],
      ["/answer", { question_id: 1, text: "no" }],
      ["/observe-session", { session_id: "s", transcript_path: "/tmp/t", cwd: "/tmp", claude_pid: 1 }],
    ] as Array<[string, unknown]>) {
      const res = await post(path, body, a.capability_token!);
      expect(`${path}:${res.status}`).toBe(`${path}:401`);
    }
  });

  test("a revoked (dead-seat) token stops authorizing", async () => {
    const res = await post("/register", {
      pid: deadPid(), cwd: "/tmp/identity", git_root: null, tty: null, summary: "doomed", role: null, model: null,
    });
    const dead = (await res.json()) as Reg;
    expect((await post("/heartbeat", { id: dead.id }, dead.capability_token!)).status).toBe(200);
    await sweep(); // reaps the dead pid, revoking its token
    expect((await post("/heartbeat", { id: dead.id }, dead.capability_token!)).status).toBe(401);
  });

  test("the shared secret still authorizes every route it did before", async () => {
    const a = await register();
    const b = await register();
    // The operator's secret is explicitly NOT constrained by seat identity: it may act on any
    // seat. This is the back-compat guarantee — a seat presenting no capability token is
    // exactly a `full` caller and keeps working.
    for (const [path, body] of [
      ["/set-state", { id: b.id, state: "blocked" }],
      ["/set-summary", { id: b.id, summary: "operator wrote this" }],
      ["/poll-messages", { id: b.id }],
      ["/ack", { id: b.id, message_ids: [1] }],
      ["/release-claims", { id: b.id }],
      ["/send-message", { from_id: a.id, to_id: b.id, text: "hi" }],
      ["/dash-token", {}],
      ["/costs", {}],
      ["/stats", {}],
    ] as Array<[string, unknown]>) {
      const res = await post(path, body);
      expect(`${path}:${res.status}`).toBe(`${path}:200`);
    }
  });

  test("a garbage or well-shaped-but-unminted token is still 401", async () => {
    expect((await post("/list-seats", { scope: "machine", cwd: "/", git_root: null }, "nonsense")).status).toBe(401);
    const shaped = "cps-" + "0".repeat(32);
    expect((await post("/list-seats", { scope: "machine", cwd: "/", git_root: null }, shaped)).status).toBe(401);
  });

  test("a dash nonce behaves exactly as before — read set + /answer, and no seat route", async () => {
    const a = await register();
    const nonce = ((await (await post("/dash-token", {})).json()) as { token: string }).token;
    // read set: still allowed
    expect((await post("/list-seats", { scope: "machine", cwd: "/", git_root: null }, nonce)).status).toBe(200);
    expect((await post("/questions", {}, nonce)).status).toBe(200);
    expect((await post("/costs", {}, nonce)).status).toBe(200);
    // seat routes: still refused, and refused as 401 (route not in DASH_ALLOWED), not the new
    // 403 — the nonce never reaches the identity check at all.
    expect((await post("/set-state", { id: a.id, state: "done" }, nonce)).status).toBe(401);
    expect((await post("/send-message", { from_id: "cli", to_id: a.id, text: "x" }, nonce)).status).toBe(401);
  });
});

// --- Task B: fleet scoping ---

describe("fleet scoping", () => {
  test("two fleets may each have a `builder`; the project-prefix fallback stops firing", async () => {
    const a = await register({ fleet: "web", name: "builder", cwd: "/tmp/web" });
    const b = await register({ fleet: "api", name: "builder", cwd: "/tmp/api" });
    const seats = (await (await sweep()).json()) as Array<{ id: string; handle?: string; fleet?: string | null }>;
    expect(seats.find((s) => s.id === a.id)!.handle).toBe("builder");
    expect(seats.find((s) => s.id === b.id)!.handle).toBe("builder");
  });

  test("a collision WITHIN one fleet still falls back to the project prefix", async () => {
    const a = await register({ fleet: "solo", name: "worker", cwd: "/tmp/projX" });
    const b = await register({ fleet: "solo", name: "worker", cwd: "/tmp/projY" });
    const seats = (await (await sweep()).json()) as Array<{ id: string; handle?: string }>;
    expect(seats.find((s) => s.id === a.id)!.handle).toBe("worker");
    expect(seats.find((s) => s.id === b.id)!.handle).toBe("worker-projy");
  });

  test("/list-seats filters by fleet when given, and returns every fleet when omitted", async () => {
    const a = await register({ fleet: "alpha", name: "one" });
    const b = await register({ fleet: "beta", name: "two" });

    const alpha = (await (await post("/list-seats", { scope: "machine", cwd: "/", git_root: null, fleet: "alpha" })).json()) as Array<{ id: string }>;
    expect(alpha.some((s) => s.id === a.id)).toBe(true);
    expect(alpha.some((s) => s.id === b.id)).toBe(false);

    const beta = (await (await post("/list-seats", { scope: "machine", cwd: "/", git_root: null, fleet: "beta" })).json()) as Array<{ id: string }>;
    expect(beta.some((s) => s.id === b.id)).toBe(true);
    expect(beta.some((s) => s.id === a.id)).toBe(false);

    const all = (await (await post("/list-seats", { scope: "machine", cwd: "/", git_root: null })).json()) as Array<{ id: string }>;
    expect(all.some((s) => s.id === a.id)).toBe(true);
    expect(all.some((s) => s.id === b.id)).toBe(true);
  });

  test("an explicit null fleet selects the DEFAULT fleet, not everything", async () => {
    const dflt = await register({ name: "plain" }); // no fleet -> the default fleet
    const named = await register({ fleet: "named", name: "other" });
    const res = (await (await post("/list-seats", { scope: "machine", cwd: "/", git_root: null, fleet: null })).json()) as Array<{ id: string }>;
    expect(res.some((s) => s.id === dflt.id)).toBe(true);
    expect(res.some((s) => s.id === named.id)).toBe(false);
  });
});

// --- Task C: crash redelivery ---

describe("crash redelivery", () => {
  // The whole point: a seat dies holding unacked mail and comes back able to finish it.
  test("a restarted seat adopts its crashed incarnation's unacked mail", async () => {
    const first = (await (await post("/register", {
      pid: deadPid(), cwd: "/tmp/redel", git_root: null, tty: null, summary: "w",
      role: null, model: null, fleet: "redel", stable_key: "redel/worker",
    })).json()) as Reg;

    await post("/send-message", { from_id: "cli", to_id: first.id, text: "finish this" });
    // Poll (not ack): the message is LEASED and in flight when the seat dies — the exact
    // state that used to be unrecoverable.
    const polled = (await (await post("/poll-messages", { id: first.id }, first.capability_token!)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(polled.messages.map((m) => m.text)).toContain("finish this");

    await sweep(); // the crash is noticed; the seat row goes, the mail stays
    const seats = (await (await sweep()).json()) as Array<{ id: string }>;
    expect(seats.some((s) => s.id === first.id)).toBe(false);

    const second = (await (await post("/register", {
      pid: deadPid(), cwd: "/tmp/redel", git_root: null, tty: null, summary: "w",
      role: null, model: null, fleet: "redel", stable_key: "redel/worker",
    })).json()) as Reg;
    expect(second.id).not.toBe(first.id);

    const redelivered = (await (await post("/poll-messages", { id: second.id }, second.capability_token!)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(redelivered.messages.map((m) => m.text)).toContain("finish this");
  });

  test("a DIFFERENT stable_key inherits nothing", async () => {
    const victim = (await (await post("/register", {
      pid: deadPid(), cwd: "/tmp/redel2", git_root: null, tty: null, summary: "v",
      role: null, model: null, fleet: "redel2", stable_key: "redel2/worker",
    })).json()) as Reg;
    await post("/send-message", { from_id: "cli", to_id: victim.id, text: "not yours" });
    await sweep();

    const other = (await (await post("/register", {
      pid: deadPid(), cwd: "/tmp/redel2", git_root: null, tty: null, summary: "o",
      role: null, model: null, fleet: "redel2", stable_key: "redel2/someone-else",
    })).json()) as Reg;
    const got = (await (await post("/poll-messages", { id: other.id }, other.capability_token!)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(got.messages).toHaveLength(0);
  });

  test("the same stable_key in ANOTHER fleet inherits nothing", async () => {
    const victim = (await (await post("/register", {
      pid: deadPid(), cwd: "/tmp/redel3", git_root: null, tty: null, summary: "v",
      role: null, model: null, fleet: "fleet-one", stable_key: "shared/name",
    })).json()) as Reg;
    await post("/send-message", { from_id: "cli", to_id: victim.id, text: "fleet-one work" });
    await sweep();

    const crossFleet = (await (await post("/register", {
      pid: deadPid(), cwd: "/tmp/redel3", git_root: null, tty: null, summary: "x",
      role: null, model: null, fleet: "fleet-two", stable_key: "shared/name",
    })).json()) as Reg;
    const got = (await (await post("/poll-messages", { id: crossFleet.id }, crossFleet.capability_token!)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(got.messages).toHaveLength(0);
  });

  // The abuse guard. stable_key is a seat NAME — public, guessable — so adoption must be a
  // resurrection primitive, never a way to take a running seat's queue.
  test("a LIVE seat's stable_key cannot be adopted, and its mail stays its own", async () => {
    const victim = await register({ fleet: "live", stable_key: "live/worker", name: "victim" });
    await post("/send-message", { from_id: "cli", to_id: victim.id, text: "victim's work" });

    // A second seat on a different (live) pid claiming the same identity while the victim runs.
    const attacker = await register({ fleet: "live", stable_key: "live/worker", name: "attacker" });
    expect(attacker.id).not.toBe(victim.id);

    const stolen = (await (await post("/poll-messages", { id: attacker.id }, attacker.capability_token!)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(stolen.messages).toHaveLength(0);

    const kept = (await (await post("/poll-messages", { id: victim.id }, victim.capability_token!)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(kept.messages.map((m) => m.text)).toContain("victim's work");
  });

  test("a seat with NO stable_key still has its mail purged immediately (pre-0.3 behaviour)", async () => {
    const res = await post("/register", {
      pid: deadPid(), cwd: "/tmp/nokey", git_root: null, tty: null, summary: "n", role: null, model: null,
    });
    const seat = (await res.json()) as Reg;
    await post("/send-message", { from_id: "cli", to_id: seat.id, text: "unreachable" });
    await sweep();
    const left = peekDb((db) =>
      db.query("SELECT COUNT(*) AS c FROM messages WHERE to_id = ? AND delivered = 0").get(seat.id)
    ) as { c: number };
    expect(left.c).toBe(0);
  });
});

// --- v0.3 wiring wave: the two boundaries the enforcement above was never actually measured
//     against, because no production seat presented a capability token and no restart ever
//     reached the adoption path. ---

describe("crash redelivery: the un-swept restart", () => {
  // The case that actually happens. `a restarted seat adopts…` above passes only because it
  // sweeps first AND registers the replacement on a pid nothing holds — two conditions a real
  // relaunch meets neither of. Production: the seat dies, the operator relaunches within
  // seconds, and the 30s sweep has not run. The dead seat therefore still has a `seats` row
  // (dead pid) and an OPEN seat_runs row, so it was invisible to adoption twice over — the
  // live-holder guard saw the REPLACEMENT's own live pid, and a run with no ended_at is not a
  // candidate. The mail was then purged by the sweep that eventually arrived.
  test("a relaunch that beats the sweep, on a REAL live pid, still adopts its unacked mail", async () => {
    // A genuine process to crash, not a fabricated pid: the guards are pid-liveness checks,
    // so a fake pid tests the wrong branch.
    const crashing = Bun.spawn(["sleep", "120"], { stdio: ["ignore", "ignore", "ignore"] });
    const first = (await (await post("/register", {
      pid: crashing.pid, cwd: "/tmp/unswept", git_root: null, tty: null, summary: "w",
      role: null, model: null, fleet: "unswept", stable_key: "unswept/worker",
    })).json()) as Reg;

    await post("/send-message", { from_id: "cli", to_id: first.id, text: "survive the crash" });
    // Leased and in flight when the process dies — unacked, so it is owed redelivery.
    const inFlight = (await (await post("/poll-messages", { id: first.id }, first.capability_token!)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(inFlight.messages.map((m) => m.text)).toContain("survive the crash");

    crashing.kill();
    await crashing.exited;

    // NO sweep(). That is the whole test: the broker has not yet noticed the crash.
    const second = (await (await post("/register", {
      pid: livePid(), cwd: "/tmp/unswept", git_root: null, tty: null, summary: "w",
      role: null, model: null, fleet: "unswept", stable_key: "unswept/worker",
    })).json()) as Reg;
    expect(second.id).not.toBe(first.id);

    const redelivered = (await (await post("/poll-messages", { id: second.id }, second.capability_token!)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(redelivered.messages.map((m) => m.text)).toContain("survive the crash");
  });

  // The abuse guard must survive the fix that made the above work: excluding the registering
  // seat from the live-holder query must not also excuse a holder that is genuinely running.
  test("an un-swept LIVE holder is still not adoptable", async () => {
    const victim = await register({ fleet: "unswept2", stable_key: "unswept2/worker" });
    await post("/send-message", { from_id: "cli", to_id: victim.id, text: "still mine" });
    const attacker = await register({ fleet: "unswept2", stable_key: "unswept2/worker" });
    const stolen = (await (await post("/poll-messages", { id: attacker.id }, attacker.capability_token!)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(stolen.messages).toHaveLength(0);
    const kept = (await (await post("/poll-messages", { id: victim.id }, victim.capability_token!)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(kept.messages.map((m) => m.text)).toContain("still mine");
  });
});

describe("fleet confinement at seat scope", () => {
  // SEAT_OWNED routes were pinned to one seat, but the SHARED ones were not pinned to anything:
  // a capability token could enumerate every fleet on the machine through /list-seats and then
  // message, diff, or read the log of any id it found. Client-side filtering (the fleet the CLI
  // puts in a /list-seats body) is a convenience, not an authorization boundary.
  let north: Reg;
  let south: Reg;
  // REAL paths, under this suite's temp dir. `/tmp/south/wt` was a path that does not exist,
  // and /worktree-add stats before it records — see the fixture assertions below for why that
  // silently hollowed out three of these tests. The "south" segment is kept in the name
  // because the /list-claims assertion matches on it.
  const southDir = join(dir, "south");
  const southWt = join(southDir, "wt");
  const southSecret = join(southDir, "secret.ts");

  beforeAll(async () => {
    mkdirSync(southWt, { recursive: true });
    writeFileSync(southSecret, "// south's file\n");
    north = await register({ fleet: "north", stable_key: "north/w", name: "northw", cwd: join(dir, "north") });
    south = await register({ fleet: "south", stable_key: "south/w", name: "southw", cwd: southDir });
    // State in the SOUTH fleet for north to fail to reach.
    //
    // Every fixture write is ASSERTED, and the rows are then confirmed through the operator's
    // own view before any confinement claim is made. Without this the suite has a silent
    // failure mode that is worse than no test: if a write is rejected — these handlers
    // canonicalize and stat paths, and /tmp/south/wt is never created on disk — then the
    // "north cannot see south's row" assertions below hold because THERE IS NO ROW, and the
    // filter they exist to exercise never runs. The path is named in each failure message so a
    // rejection reads as a rejection instead of as a mystery.
    const fixtures: Array<[string, unknown, string | undefined]> = [
      ["/send-message", { from_id: "cli", to_id: south.id, text: "south-only traffic" }, undefined],
      ["/worktree-add", { id: south.id, path: southWt, branch: "s", base_commit: "abc" }, south.capability_token],
      ["/claim-path", { id: south.id, paths: [southSecret] }, south.capability_token],
      ["/ask", { id: south.id, text: "south question" }, south.capability_token],
    ];
    for (const [path, body, token] of fixtures) {
      const res = token === undefined ? await post(path, body) : await post(path, body, token);
      const detail = await res.text();
      expect(`${path} ${res.status} ${detail}`).toBe(`${path} 200 ${detail}`);
      // A 200 is not enough on the routes that answer {ok:false, error} in-band.
      if (detail.includes('"ok"')) expect(`${path} ${detail}`).toContain('"ok":true');
    }

    // The rows exist as far as the OPERATOR is concerned. This is the control: every
    // confinement assertion below is only meaningful against state that is really there.
    const trees = (await (await post("/worktree-list", {})).json()) as Array<{ seat_id: string }>;
    expect(trees.some((w) => w.seat_id === south.id)).toBe(true);
    const claims = (await (await post("/list-claims", {})).json()) as Array<{ owner_id: string }>;
    expect(claims.some((c) => c.owner_id === south.id)).toBe(true);
    const questions = (await (await post("/questions", {})).json()) as Array<{ from_id: string }>;
    expect(questions.some((q) => q.from_id === south.id)).toBe(true);
    const log = (await (await post("/log", {})).json()) as { messages: Array<{ text: string }> };
    expect(log.messages.some((m) => m.text === "south-only traffic")).toBe(true);
  });

  test("/list-seats cannot enumerate another fleet, whatever fleet the body asks for", async () => {
    // Asking for south explicitly is the direct attempt...
    const asked = (await (await post("/list-seats", { scope: "machine", cwd: "/", git_root: null, fleet: "south" }, north.capability_token!)).json()) as Array<{ id: string }>;
    expect(asked.some((s) => s.id === south.id)).toBe(false);
    expect(asked.some((s) => s.id === north.id)).toBe(true);
    // ...and omitting the key entirely used to mean "every fleet".
    const omitted = (await (await post("/list-seats", { scope: "machine", cwd: "/", git_root: null }, north.capability_token!)).json()) as Array<{ id: string }>;
    expect(omitted.some((s) => s.id === south.id)).toBe(false);
    expect(omitted.some((s) => s.id === north.id)).toBe(true);
  });

  test("/send-message cannot reach a seat in another fleet", async () => {
    const res = await post("/send-message", { from_id: north.id, to_id: south.id, text: "cross-fleet" }, north.capability_token!);
    expect(res.status).toBe(403);
    // ...and nothing was queued: south's next poll sees only its own traffic.
    const inbox = (await (await post("/poll-messages", { id: south.id }, south.capability_token!)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(inbox.messages.map((m) => m.text)).not.toContain("cross-fleet");
  });

  test("/log cannot read another fleet's messages", async () => {
    const seen = (await (await post("/log", {}, north.capability_token!)).json()) as {
      messages: Array<{ to_id: string; text: string }>;
    };
    expect(seen.messages.some((m) => m.to_id === south.id)).toBe(false);
    expect(seen.messages.some((m) => m.text === "south-only traffic")).toBe(false);
  });

  test("/diff cannot read another fleet's working tree", async () => {
    expect((await post("/diff", { id: south.id }, north.capability_token!)).status).toBe(403);
  });

  test("/worktree-list, /list-claims and /questions are confined to the caller's fleet", async () => {
    // Explicit foreign target: refused outright.
    expect((await post("/worktree-list", { id: south.id }, north.capability_token!)).status).toBe(403);
    // Unfiltered: the foreign rows are simply not there.
    const trees = (await (await post("/worktree-list", {}, north.capability_token!)).json()) as Array<{ seat_id: string }>;
    expect(trees.some((w) => w.seat_id === south.id)).toBe(false);

    const claims = (await (await post("/list-claims", {}, north.capability_token!)).json()) as Array<{ owner_id: string; path: string }>;
    expect(claims.some((c) => c.owner_id === south.id)).toBe(false);
    expect(claims.some((c) => c.path.includes("south/secret.ts"))).toBe(false);

    const questions = (await (await post("/questions", {}, north.capability_token!)).json()) as Array<{ from_id: string }>;
    expect(questions.some((q) => q.from_id === south.id)).toBe(false);
  });

  test("/wait-for cannot observe a seat in another fleet", async () => {
    const res = await post("/wait-for", { id: north.id, target: south.id, until: ["done"], timeout_ms: 0 }, north.capability_token!);
    expect(res.status).toBe(403);
  });

  test("the OPERATOR still crosses fleets — this is a seat-scope boundary, not a global one", async () => {
    const all = (await (await post("/list-seats", { scope: "machine", cwd: "/", git_root: null })).json()) as Array<{ id: string }>;
    expect(all.some((s) => s.id === north.id)).toBe(true);
    expect(all.some((s) => s.id === south.id)).toBe(true);
    const claims = (await (await post("/list-claims", {})).json()) as Array<{ owner_id: string }>;
    expect(claims.some((c) => c.owner_id === south.id)).toBe(true);
    expect((await post("/diff", { id: south.id })).status).toBe(200);
  });
});
