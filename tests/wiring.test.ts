/**
 * v0.3 client wiring — the seam that made the whole capability boundary dead code.
 *
 * The broker's enforcement (per-seat route allowlist, subject checks, fleet confinement) is
 * covered in identity.test.ts, and it all passed while NO production seat ever crossed it:
 * every backend authenticated with the machine-wide secret, which resolves to `full` scope, so
 * a seat token never reached the checks. Nothing broker-side could detect that — the missing
 * behaviour was entirely in the three clients. Hence this file, which asserts what the SEAT
 * PROCESSES do:
 *
 *   1. the credential on the wire, per call, for all three backends (a stub broker, because a
 *      capability token is by construction not readable anywhere else — the real broker stores
 *      only its hash and never hands it back);
 *   2. that fleet + stable_key survive into the broker's ROW, against the real broker (a
 *      request body that is never persisted proves nothing).
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "patrol-wiring-"));
const SECRET_FILE = join(dir, "secret");
const SECRET = "wiring-shared-secret-value";
const SEAT_CWD = join(dir, "cwd");
const SEAT_SERVER = new URL("../src/seat-server.ts", import.meta.url).pathname;
const CODEX_SEAT = new URL("../src/codex-seat.ts", import.meta.url).pathname;
const HEADLESS_SEAT = new URL("../src/headless-seat.ts", import.meta.url).pathname;

const BACKENDS: Array<{ name: string; script: string; stdin: "pipe" | "ignore" }> = [
  // seat-server is an stdio MCP server: its stdin must stay open or it exits before it polls.
  { name: "seat-server", script: SEAT_SERVER, stdin: "pipe" },
  { name: "codex-seat", script: CODEX_SEAT, stdin: "ignore" },
  { name: "headless-seat", script: HEADLESS_SEAT, stdin: "ignore" },
];

const spawned: ReturnType<typeof Bun.spawn>[] = [];
function spawnSeat(script: string, stdin: "pipe" | "ignore", env: Record<string, string>) {
  const p = Bun.spawn(["bun", script], {
    cwd: SEAT_CWD,
    env: { ...process.env, CLAUDE_PATROL_SECRET_FILE: SECRET_FILE, ...env },
    stdio: [stdin, "ignore", "ignore"],
  });
  spawned.push(p);
  return p;
}

async function until<T>(fn: () => T | null | undefined, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) return v;
    if (Date.now() >= deadline) throw new Error("timed out waiting for the seat");
    await new Promise((r) => setTimeout(r, 60));
  }
}

beforeAll(() => {
  mkdirSync(SEAT_CWD, { recursive: true });
  writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 });
});

afterAll(() => {
  for (const p of spawned) p.kill();
  rmSync(dir, { recursive: true, force: true });
});

// --- 1. the credential on the wire -------------------------------------------------------

describe("a seat authenticates with its capability token, not the shared secret", () => {
  // A stub broker: it records the auth header of every request and answers just enough for a
  // seat to boot. The point of the stub is that it can OBSERVE the header — the real broker
  // cannot tell us which credential arrived (both are accepted, one at `full` and one at
  // `seat` scope), and that indistinguishability is exactly how this shipped broken.
  const CAP = "cps-" + "ab".repeat(16); // shape-valid; the stub, not a hash lookup, validates it
  let stub: ReturnType<typeof Bun.serve>;
  let seen: Array<{ path: string; token: string | null }> = [];
  let lastRegisterBody: Record<string, unknown> | null = null;

  beforeAll(() => {
    stub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (req.method !== "POST") return new Response("ok"); // /health
        const token = req.headers.get("x-patrol-token");
        seen.push({ path, token });
        if (path === "/register") {
          lastRegisterBody = (await req.json()) as Record<string, unknown>;
          return Response.json({ id: "stub1234", capability_token: CAP });
        }
        if (path === "/poll-messages") return Response.json({ messages: [] });
        return Response.json({ ok: true });
      },
    });
  });
  afterAll(() => stub.stop(true));

  for (const backend of BACKENDS) {
    test(`${backend.name}: the secret bootstraps /register and then leaves the request path`, async () => {
      seen = [];
      lastRegisterBody = null;
      const proc = spawnSeat(backend.script, backend.stdin, {
        CLAUDE_PATROL_PORT: String(stub.port),
        CLAUDE_PATROL_ROLE: "builder",
        CLAUDE_PATROL_MODEL: "opus",
        CLAUDE_PATROL_FLEET: "wire",
        CLAUDE_PATROL_STABLE_KEY: "wire/builder",
      });
      try {
        // Wait for THIS seat to register, then for a call it makes afterwards (its poll timer
        // fires first). One seat at a time — a leftover backend still polling the stub would
        // satisfy the second wait before the current one had registered at all.
        await until(() => seen.find((c) => c.path === "/register"));
        await until(() => seen.slice(seen.findIndex((c) => c.path === "/register") + 1).find((c) => c.path === "/poll-messages"));
      } finally {
        proc.kill();
        await proc.exited;
      }

      // The bootstrap call, and ONLY it, carries the machine-wide secret: a seat has no
      // capability until it has registered.
      const register = seen.filter((c) => c.path === "/register");
      expect(register).toHaveLength(1);
      expect(register[0]!.token).toBe(SECRET);

      // Everything after it carries the minted capability token. This is the assertion the
      // v0.3 broker work was missing: with the secret here instead, every request resolves to
      // `full` operator scope and the entire per-seat boundary is bypassed.
      const after = seen.filter((c) => c.path !== "/register");
      expect(after.length).toBeGreaterThan(0);
      for (const call of after) {
        expect(call.token).toBe(CAP);
        expect(call.token).not.toBe(SECRET);
      }
      // Stated as a whole-transcript property too, so a future route added to the seat's
      // startup path cannot quietly reintroduce the secret.
      expect(seen.filter((c) => c.token === SECRET).map((c) => c.path)).toEqual(["/register"]);

      // Finding 2, at the request level; the row-level assertion is against the real broker below.
      expect(lastRegisterBody!.fleet).toBe("wire");
      expect(lastRegisterBody!.stable_key).toBe("wire/builder");
    }, 15_000);
  }
});

// A broker too old to mint a capability token. The seat keeps its bootstrap credential rather
// than refusing to boot — a hard failure here would take a whole fleet down on a mixed-version
// install — but it must SAY so, because a silent degrade is precisely how the boundary became
// dead code the first time.
test("no capability_token from the broker degrades to the secret, loudly", async () => {
  const calls: Array<{ path: string; token: string | null }> = [];
  const old = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method !== "POST") return new Response("ok");
      calls.push({ path, token: req.headers.get("x-patrol-token") });
      if (path === "/register") return Response.json({ id: "stub1234" }); // pre-v0.3: no token
      if (path === "/poll-messages") return Response.json({ messages: [] });
      return Response.json({ ok: true });
    },
  });
  const proc = Bun.spawn(["bun", CODEX_SEAT], {
    cwd: SEAT_CWD,
    env: {
      ...process.env,
      CLAUDE_PATROL_SECRET_FILE: SECRET_FILE,
      CLAUDE_PATROL_PORT: String(old.port),
      CLAUDE_PATROL_ROLE: "builder",
      CLAUDE_PATROL_MODEL: "opus",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  spawned.push(proc);
  try {
    await until(() => calls.find((c) => c.path === "/poll-messages"));
    // Still functional, on the only credential it has.
    expect(calls.every((c) => c.token === SECRET)).toBe(true);
  } finally {
    proc.kill();
    await proc.exited;
    old.stop(true);
  }
  const stderr = await new Response(proc.stderr).text();
  expect(stderr).toContain("no capability_token");
  expect(stderr).toContain("OPERATOR scope");
}, 15_000);

// --- 2. fleet + stable_key reach the broker's row -----------------------------------------

describe("registration persists fleet + stable_key for every backend", () => {
  // Against the REAL broker, asserting the stored row. The launcher has always exported both
  // env vars (compose.ts FLEET_ENV / STABLE_KEY_ENV); no backend read them, so every real seat
  // was stored fleet=NULL, stable_key=NULL — handles collided across projects, a null-fleet
  // seat resolved into every fleet, and endSeat purged unacked mail instead of retaining it.
  const PORT = 17913;
  const DB_FILE = join(dir, "real.db");
  let broker: ReturnType<typeof Bun.spawn>;

  beforeAll(async () => {
    broker = Bun.spawn(["bun", new URL("../src/broker.ts", import.meta.url).pathname], {
      env: {
        ...process.env,
        CLAUDE_PATROL_PORT: String(PORT),
        CLAUDE_PATROL_DB: DB_FILE,
        CLAUDE_PATROL_SECRET_FILE: SECRET_FILE,
        CLAUDE_PATROL_PROJECTS_ROOT: join(dir, "projects"),
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    spawned.push(broker);
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  // Looked up by ROLE, not pid: seat-server registers its PARENT process (the claude session
  // it serves), which under `bun test` is the test runner — so a pid lookup would find the
  // wrong row for one of the three backends and silently pass on another's.
  function seatRow(role: string) {
    const db = new Database(DB_FILE, { readonly: true });
    try {
      return db.query("SELECT id, fleet, stable_key FROM seats WHERE role = ?").get(role) as
        | { id: string; fleet: string | null; stable_key: string | null }
        | null;
    } finally {
      db.close();
    }
  }

  for (const backend of BACKENDS) {
    test(`${backend.name}: the stored row carries the launcher's fleet and stable key`, async () => {
      const fleet = `f-${backend.name}`;
      const key = `${fleet}/builder`;
      const role = `role-${backend.name}`;
      spawnSeat(backend.script, backend.stdin, {
        CLAUDE_PATROL_PORT: String(PORT),
        CLAUDE_PATROL_ROLE: role,
        CLAUDE_PATROL_MODEL: "opus",
        CLAUDE_PATROL_FLEET: fleet,
        CLAUDE_PATROL_STABLE_KEY: key,
      });
      const row = await until(() => seatRow(role));
      expect(row.fleet).toBe(fleet);
      expect(row.stable_key).toBe(key);
    }, 15_000);
  }

  test("a seat launched WITHOUT the fleet env still registers, unfleeted", async () => {
    // The hand-launched / pre-0.3 path: absent env must mean the default fleet, not a crash
    // and not a fabricated fleet name.
    spawnSeat(CODEX_SEAT, "ignore", {
      CLAUDE_PATROL_PORT: String(PORT),
      CLAUDE_PATROL_ROLE: "solo-unfleeted",
      CLAUDE_PATROL_MODEL: "opus",
    });
    const row = await until(() => seatRow("solo-unfleeted"));
    expect(row.fleet).toBeNull();
    expect(row.stable_key).toBeNull();
  }, 15_000);
});
