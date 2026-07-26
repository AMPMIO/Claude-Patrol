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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCredential } from "../src/commands/_client.ts";
import { credFilePath, CRED_FILE_ENV } from "../shared/auth.ts";
import { STABLE_KEY_ENV } from "../src/launcher/compose.ts";

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
let credSeq = 0;
function spawnSeat(script: string, stdin: "pipe" | "ignore", env: Record<string, string>) {
  const p = Bun.spawn(["bun", script], {
    cwd: SEAT_CWD,
    env: {
      ...process.env,
      CLAUDE_PATROL_SECRET_FILE: SECRET_FILE,
      // Every spawned seat now persists its capability for its own CLI. Pin it inside the
      // temp dir: the default derives from the stable key under the REAL home, and a test
      // must never write a credential file next to this machine's live seats.
      CLAUDE_PATROL_CRED_FILE: join(dir, `spawn-cred-${credSeq++}`),
      // Cleared, not merely unset: `process.env` is spread above, and anyone actually RUNNING
      // patrol has these exported in the shell they run `bun test` from — which would silently
      // fleet the "registers WITHOUT the fleet env" case and pass for the wrong reason. Empty
      // is the read the absent case wants (fleetFieldsFromEnv degrades `""` to null). Tests
      // that need a fleet set it through `env` below, which wins.
      CLAUDE_PATROL_FLEET: "",
      CLAUDE_PATROL_STABLE_KEY: "",
      ...env,
    },
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

// A broker too old to mint a capability token. Through v0.3 the seat KEPT its bootstrap secret
// and logged a warning; the result was that a stale broker — this machine ran one for twelve
// days — silently put every seat at operator scope, which is the exact hole the release exists
// to close. A log line is not a control, so the seat now refuses. The message has to be
// actionable rather than merely fatal: this broker auto-restarts, so naming the one command
// that fixes it is the difference between a 10-second fix and a mystery.
for (const backend of BACKENDS) {
  test(`${backend.name}: no capability_token from the broker REFUSES to run, actionably`, async () => {
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
    const proc = Bun.spawn(["bun", backend.script], {
      cwd: SEAT_CWD,
      env: {
        ...process.env,
        CLAUDE_PATROL_SECRET_FILE: SECRET_FILE,
        CLAUDE_PATROL_PORT: String(old.port),
        CLAUDE_PATROL_ROLE: "builder",
        CLAUDE_PATROL_MODEL: "opus",
      },
      stdio: [backend.stdin, "ignore", "pipe"],
    });
    spawned.push(proc);
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    old.stop(true);

    expect(exitCode).not.toBe(0);
    // The refusal is the point: nothing beyond the bootstrap /register ever went on the wire,
    // so no request was made at `full` scope.
    expect(calls.map((c) => c.path)).toEqual(["/register"]);
    expect(stderr).toContain("no capability_token");
    expect(stderr).toContain("OPERATOR scope");
    // Actionable, not just fatal — the cause and the literal fix.
    expect(stderr).toContain("predates v0.3");
    expect(stderr).toContain("patrol down");
  }, 15_000);
}

// --- 1b. the seat's own CLI credential -----------------------------------------------------

describe("the seat persists its capability where its own `patrol` CLI finds it", () => {
  const CAP = "cps-" + "cd".repeat(16);
  let stub: ReturnType<typeof Bun.serve>;
  let registered = 0;

  beforeAll(() => {
    stub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (req.method !== "POST") return new Response("ok");
        if (path === "/register") {
          registered++;
          return Response.json({ id: "stub1234", capability_token: CAP });
        }
        if (path === "/poll-messages") return Response.json({ messages: [] });
        return Response.json({ ok: true });
      },
    });
  });
  afterAll(() => stub.stop(true));

  for (const backend of BACKENDS) {
    test(`${backend.name}: writes it 0600 and removes it on teardown`, async () => {
      const credFile = join(dir, `cred-${backend.name}`);
      const before = registered;
      const proc = spawnSeat(backend.script, backend.stdin, {
        CLAUDE_PATROL_PORT: String(stub.port),
        CLAUDE_PATROL_ROLE: "builder",
        CLAUDE_PATROL_MODEL: "opus",
        CLAUDE_PATROL_FLEET: "wire",
        CLAUDE_PATROL_STABLE_KEY: "wire/builder",
        CLAUDE_PATROL_CRED_FILE: credFile,
      });
      try {
        await until(() => (registered > before ? true : null));
        await until(() => (existsSync(credFile) ? true : null));
        expect(JSON.parse(readFileSync(credFile, "utf8"))).toEqual({ seat_id: "stub1234", token: CAP });
        // 0600 exactly. A group-readable capability file hands this seat's authority to
        // anything else running as a member of that group.
        expect(statSync(credFile).mode & 0o777).toBe(0o600);
      } finally {
        // SIGTERM, not kill(): the teardown path that removes the file is the SIGTERM handler.
        proc.kill("SIGTERM");
        await proc.exited;
      }
      await until(() => (existsSync(credFile) ? null : true));
      expect(existsSync(credFile)).toBe(false);
    }, 15_000);
  }
});

// --- 1c. which credential the CLI itself picks ---------------------------------------------
//
// readCredential is the whole finding-2 fix: the seat-server's MCP instructions tell a seat to
// run `patrol send/list/status` through Bash, and that path read the OPERATOR secret — so the
// normal seat action arrived as `full` scope and the broker's per-seat checks never ran.

describe("the CLI authenticates as the seat when it is running as one", () => {
  test("a readable seat credential wins over the operator secret", async () => {
    const f = join(dir, "cli-cred");
    const token = "cps-" + "ef".repeat(16);
    writeFileSync(f, JSON.stringify({ seat_id: "seatabcd", token }), { mode: 0o600 });
    process.env[CRED_FILE_ENV] = f;
    process.env.CLAUDE_PATROL_SECRET_FILE = SECRET_FILE;
    try {
      const cred = await readCredential();
      expect(cred).toEqual({ token, scope: "seat", seatId: "seatabcd" });
    } finally {
      delete process.env[CRED_FILE_ENV];
    }
  });

  test("the human's own shell — no seat credential — still gets the operator secret", async () => {
    delete process.env[CRED_FILE_ENV];
    delete process.env.CLAUDE_PATROL_STABLE_KEY;
    process.env.CLAUDE_PATROL_SECRET_FILE = SECRET_FILE;
    const cred = await readCredential();
    expect(cred).toEqual({ token: SECRET, scope: "operator", seatId: null });
  });

  test("a credential file that is not there degrades to the operator, not to nothing", async () => {
    // The seat env is present but the file is absent: a hook firing before /register, or a
    // shell inside a seat's tmux window after teardown. Falling through is right BECAUSE
    // nothing was presented — see readCredential on why a REJECTED seat token must not.
    process.env[CRED_FILE_ENV] = join(dir, "definitely-absent");
    process.env.CLAUDE_PATROL_SECRET_FILE = SECRET_FILE;
    try {
      const cred = await readCredential();
      expect(cred).toEqual({ token: SECRET, scope: "operator", seatId: null });
    } finally {
      delete process.env[CRED_FILE_ENV];
    }
  });

  // The path rule lives in shared/auth.ts (seats + CLI) AND as a hand copy in
  // plugin/hooks/dereg.ts, which may not import across directories because it is packaged
  // standalone. A drift would be silent — every SessionEnd would quietly go back to the
  // operator secret — so the copy is executed here, against the same env, and its answer must
  // equal the shared one. Same discipline as guard-hook.test.ts pinning LEASE_FILE_ENV.
  test("dereg.ts derives the same credential path as shared/auth.ts", async () => {
    const key = "weird name/b-c.d";
    const hookSrc = readFileSync(new URL("../plugin/hooks/dereg.ts", import.meta.url).pathname, "utf8");
    // Take the copy verbatim, minus the top-level side effects (the fetch and process.exit).
    const body = hookSrc.slice(hookSrc.indexOf("function credFile()"), hookSrc.indexOf("async function readAuth"));
    expect(body).toContain("CLAUDE_PATROL_STABLE_KEY"); // the slice actually caught the function
    const probe = join(dir, "dereg-probe.ts");
    writeFileSync(
      probe,
      `import { createHash } from "node:crypto";\nimport { homedir } from "node:os";\nimport { join } from "node:path";\n${body}\nconsole.log(credFile());\n`
    );
    const out = await new Response(
      Bun.spawn(["bun", probe], { env: { ...process.env, CLAUDE_PATROL_STABLE_KEY: key, CLAUDE_PATROL_CRED_FILE: "" }, stdio: ["ignore", "pipe", "ignore"] }).stdout
    ).text();
    rmSync(probe, { force: true });
    expect(out.trim()).toBe(credFilePath({ CLAUDE_PATROL_STABLE_KEY: key })!);
  }, 15_000);

  // The launcher owns the seat side of the stable-key seam (compose.ts STABLE_KEY_ENV);
  // shared/auth.ts spells it as a literal because it may not import src/launcher (it is on the
  // broker's import graph). Same drift guard.
  test("the stable-key env name matches the launcher's", () => {
    expect(credFilePath({ [STABLE_KEY_ENV]: "acme/builder" })).toBe(
      credFilePath({ CLAUDE_PATROL_STABLE_KEY: "acme/builder" })
    );
    expect(credFilePath({ [STABLE_KEY_ENV]: "acme/builder" })).not.toBeNull();
  });

  // Readable-slug collisions would put two live seats on ONE credential file, i.e. a seat's
  // CLI acting as a different seat. The hash suffix is what makes that unreachable.
  test("stable keys that slug identically still get distinct files", () => {
    expect(credFilePath({ CLAUDE_PATROL_STABLE_KEY: "a/b-c" })).not.toBe(
      credFilePath({ CLAUDE_PATROL_STABLE_KEY: "a-b/c" })
    );
  });

  test("no stable key and no override means no seat credential at all", () => {
    expect(credFilePath({})).toBeNull();
  });
});

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

// --- 3. the boundary on the path a seat is actually told to use ----------------------------
//
// This is finding 2 end to end, through the REAL CLI and the REAL broker. The seat-server's
// own MCP instructions tell seats to run `patrol send <id> <msg>` through Bash. Before v0.3.1
// that command read the operator secret, resolved to `full` scope, and crossed every fleet on
// the machine. The same binary must now be confined when a seat runs it and unconfined when
// the human does — one command, two authorities, asserted side by side.

describe("`patrol send` is fleet-confined for a seat and unconfined for the operator", () => {
  const PORT = 17914;
  const DB_FILE = join(dir, "cross.db");
  const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
  const NORTH_DIR = join(dir, "north");
  const SOUTH_DIR = join(dir, "south");
  let broker: ReturnType<typeof Bun.spawn>;
  let southCap = "";

  // One seat per PID — the broker keys liveness on it, so two registrations sharing this
  // process's pid would leave only the second row. Each side gets its own idle process.
  async function register(fleet: string, role: string): Promise<{ id: string; capability_token?: string }> {
    const holder = Bun.spawn(["sleep", "300"], { stdio: ["ignore", "ignore", "ignore"] });
    spawned.push(holder);
    const res = await fetch(`http://127.0.0.1:${PORT}/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-patrol-token": SECRET },
      body: JSON.stringify({
        pid: holder.pid, cwd: fleet === "north" ? NORTH_DIR : SOUTH_DIR, git_root: null, tty: null,
        summary: "", role, model: "opus", profile: null, fleet, stable_key: `${fleet}/${role}`,
      }),
    });
    return (await res.json()) as { id: string; capability_token?: string };
  }

  // `patrol` resolves the CALLER's fleet from the governing patrol.yaml, so each side needs a
  // real directory with a real config — this is the seam being tested, not a stub.
  function runCli(cwd: string, args: string[], credFile: string | null) {
    const env: Record<string, string> = {
      ...process.env,
      CLAUDE_PATROL_SECRET_FILE: SECRET_FILE,
      CLAUDE_PATROL_PORT: String(PORT),
    };
    // Empty string, not delete: this process may itself be running inside a seat.
    env.CLAUDE_PATROL_CRED_FILE = credFile ?? "";
    env.CLAUDE_PATROL_STABLE_KEY = "";
    const r = Bun.spawnSync(["bun", CLI, ...args], { cwd, env });
    return {
      code: r.exitCode,
      out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr),
    };
  }

  beforeAll(async () => {
    for (const [d, fleet] of [[NORTH_DIR, "north"], [SOUTH_DIR, "south"]] as const) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "patrol.yaml"), `fleet: ${fleet}\nseats:\n  - name: ${fleet === "north" ? "alpha" : "beta"}\n    model: opus\n`);
    }
    broker = Bun.spawn(["bun", new URL("../src/broker.ts", import.meta.url).pathname], {
      env: {
        ...process.env,
        CLAUDE_PATROL_PORT: String(PORT),
        CLAUDE_PATROL_DB: DB_FILE,
        CLAUDE_PATROL_SECRET_FILE: SECRET_FILE,
        CLAUDE_PATROL_PROJECTS_ROOT: join(dir, "cross-projects"),
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    spawned.push(broker);
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    await register("north", "alpha");
    const south = await register("south", "beta");
    southCap = south.capability_token!;
    // The real broker never hands this back again — it stores only the hash — so this is the
    // one moment the token can be placed where a seat's CLI would find it.
    writeFileSync(join(dir, "south.cred"), JSON.stringify({ seat_id: south.id, token: southCap }), { mode: 0o600 });
  });

  test("the broker minted a capability for the seat", () => {
    expect(southCap).toMatch(/^cps-[0-9a-f]{32}$/);
  });

  test("a SEAT cannot reach another fleet with `other-fleet/handle`", () => {
    const r = runCli(SOUTH_DIR, ["send", "north/alpha", "cross-fleet from a seat"], join(dir, "south.cred"));
    expect(r.code).not.toBe(0);
    // The confinement bites at resolution: /list-seats never showed north's seat to a
    // south-scope caller, so the target does not exist as far as this seat is concerned.
    expect(r.out).toContain('no live seat matches "alpha" in fleet "north"');
  });

  test("the OPERATOR still can — `other-fleet/handle` resolves from the human's own shell", () => {
    const r = runCli(SOUTH_DIR, ["send", "north/alpha", "cross-fleet from the operator"], null);
    expect(r.code).toBe(0);
  });

  test("a seat's own fleet is unaffected — the boundary confines, it does not break `send`", () => {
    const r = runCli(SOUTH_DIR, ["send", "beta", "same-fleet from a seat"], join(dir, "south.cred"));
    expect(r.code).toBe(0);
  });

  // The credential is found through the ENVIRONMENT, so a human who attaches to a seat's tmux
  // window inherits it and speaks as that seat in the `[from ...]` header the trust model calls
  // authoritative. That is a provenance surprise, and the only thing standing between it and
  // silence is this line. Both halves are pinned: present when speaking as a seat, ABSENT for
  // the operator — a notice that always printed would train everyone to ignore it.
  test("`send` says so when it speaks as a seat, and stays quiet for the operator", () => {
    const asSeat = runCli(SOUTH_DIR, ["send", "beta", "provenance check"], join(dir, "south.cred"));
    expect(asSeat.code).toBe(0);
    expect(asSeat.out).toContain("as seat ");
    expect(asSeat.out).toContain("not the operator's");

    const asOperator = runCli(SOUTH_DIR, ["send", "beta", "provenance check"], null);
    expect(asOperator.code).toBe(0);
    expect(asOperator.out).not.toContain("as seat ");
    expect(asOperator.out.trim()).toBe("sent to beta");
  });
});
