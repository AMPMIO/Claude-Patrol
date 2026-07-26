/**
 * v0.2.6 task-worktree lifecycle: `patrol worktree` + `patrol checkpoint`.
 *
 *  - Broker route tests (mirrors broker.test.ts / questions.test.ts style): the
 *    /worktree-add · /worktree-list · /worktree-remove association CRUD, list by id
 *    vs all, idempotent remove, endSeat reaping the association, and owner-scoping.
 *  - Pure command-sequence unit tests: the git argv the two commands emit — so the
 *    DANGEROUS merge-back path is asserted without running git live (mirrors
 *    cockpit.test.ts's cockpitCommands coverage).
 *  - One real end-to-end smoke in a throwaway git repo: `patrol worktree` creates +
 *    records; `checkpoint --gate false` aborts without merging; `--gate true` merges
 *    + removes; and checkpoint REFUSES when the trunk is a live checkout (the safety
 *    keystone — it never mutates a tree it doesn't own).
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { spawnSync } from "bun";
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  worktreeDirSegment,
  worktreeAddArgs,
  classifyExistingWorktree,
} from "../src/commands/worktree.ts";
import { checkpointPlan, TRUNK } from "../src/commands/checkpoint.ts";
import { Database } from "bun:sqlite";
import type { Seat } from "../shared/types.ts";

const PORT = 17909;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "patrol-worktree-"));
const SECRET_FILE = join(dir, "secret");
const DB_FILE = join(dir, "test.db");
const PROJECTS_ROOT = join(dir, "projects");
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

let broker: ReturnType<typeof Bun.spawn>;
let TOKEN: string;

async function post(path: string, body: unknown, token = TOKEN) {
  return fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-patrol-token": token },
    body: JSON.stringify(body),
  });
}

// Each seat needs a DISTINCT alive pid: the broker retires a same-pid seat on
// re-register, so process.pid can't back two live seats at once. Real sleepers give
// distinct, alive pids (mirrors claims.test.ts); reaped in afterAll.
const sleepers: ReturnType<typeof Bun.spawn>[] = [];
function alivePid(): number {
  const p = Bun.spawn(["sleep", "120"], { stdio: ["ignore", "ignore", "ignore"] });
  sleepers.push(p);
  return p.pid;
}

// Register a LIVE seat and return its id.
async function registerSeat(fields: Record<string, unknown> = {}): Promise<string> {
  const res = await post("/register", {
    pid: alivePid(),
    cwd: "/tmp/wt-seat",
    git_root: null,
    tty: null,
    summary: "builder",
    role: null,
    model: null,
    ...fields,
  });
  return ((await res.json()) as { id: string }).id;
}

// v0.2.9: the broker canonicalizes association paths with realpathSync, so a path can only
// be recorded once it EXISTS — association tests need real directories, not fake strings.
// (Lexical normalization was rejected: deleting a ".." segment resolves through a symlink to
// the wrong directory, which is the aliasing hole this closes.)
const WT_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "patrol-wtpaths-")));
function wtDir(name: string): string {
  const p = join(WT_ROOT, name);
  mkdirSync(p, { recursive: true });
  return p;
}

// v0.2.9: `patrol checkpoint` REFUSES an unguarded seat (it cannot be quiesced, so a merge
// could race it), so the end-to-end tests register seats the way a v0.2.9 launcher does —
// guarded, with the LEASE_FILE_ENV path it handed the seat. No guard hook actually runs in
// these tests, which is what keeps the FENCE coverage below honest: the fake seat really can
// still commit mid-checkpoint, and the fences must still catch it.
let leaseFileSeq = 0;
async function registerGuardedSeat(fields: Record<string, unknown> = {}): Promise<string> {
  return registerSeat({ guarded: true, lease_file: join(WT_ROOT, `lease-${leaseFileSeq++}.json`), ...fields });
}

// The lease table has no read route (the frozen contract exposes acquire + release only),
// and expiry is a frozen 120s constant with no env override — so these two read and age a
// lease through the broker's own SQLite file. A second WAL connection is safe here, and it
// keeps the assertions on the broker's real state rather than on what a handler echoed back.
function leaseDb(): Database {
  return new Database(DB_FILE);
}
// Falls back to the raw string when the tree is already gone — a checkpoint removes the
// worktree before releasing, so the most important assertions run against a path realpath
// can no longer resolve (the broker's canonicalPathOrRaw does the same, for the same reason).
function canonicalOrRaw(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
function leaseRow(path: string): { seat_id: string; expires_at: string } | null {
  const db = leaseDb();
  try {
    return db.query("SELECT seat_id, expires_at FROM checkpoint_leases WHERE path = ?").get(canonicalOrRaw(path)) as
      | { seat_id: string; expires_at: string }
      | null;
  } finally {
    db.close();
  }
}
function expireLease(path: string) {
  const db = leaseDb();
  try {
    db.run("UPDATE checkpoint_leases SET expires_at = ? WHERE path = ?", [new Date(Date.now() - 1000).toISOString(), realpathSync(path)]);
  } finally {
    db.close();
  }
}

type Wt = { seat_id: string; path: string; branch: string; base_commit: string; created_at: string };
async function listWorktrees(id?: string): Promise<Wt[]> {
  return (await (await post("/worktree-list", id ? { id } : {})).json()) as Wt[];
}

// Run a shell command; return exit + captured output. Used to drive real git.
function sh(cmd: string[], cwd?: string, env?: Record<string, string>): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, { cwd, env: env ? { ...process.env, ...env } : process.env });
  return { code: r.exitCode ?? 1, out: r.stdout?.toString() ?? "", err: r.stderr?.toString() ?? "" };
}
function git(cwd: string, ...args: string[]) {
  return sh(["git", "-C", cwd, ...args]);
}

// Resolved BEFORE any PATH shim exists, so a shim can delegate to the real binary.
const REAL_GIT = sh(["sh", "-c", "command -v git"]).out.trim();

// A throwaway git repo with one commit on `main`. `detachPrimary` frees the trunk so
// checkpoint can advance it (the correct worktree-per-task layout: nobody camps main).
function makeRepo(detachPrimary: boolean): string {
  // realpath so the path matches what the CLI derives from its (realpath'd) cwd —
  // on macOS /var is a symlink to /private/var.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "patrol-repo-")));
  sh(["git", "init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  sh(["sh", "-c", `echo base > "${repo}/f.txt"`]);
  git(repo, "add", "f.txt");
  git(repo, "commit", "-qm", "base");
  if (detachPrimary) git(repo, "checkout", "-q", "--detach");
  return repo;
}

beforeAll(async () => {
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
});

afterAll(() => {
  broker.kill();
  for (const s of sleepers) s.kill();
  rmSync(dir, { recursive: true, force: true });
  rmSync(WT_ROOT, { recursive: true, force: true });
});

// --- broker route tests ------------------------------------------------------

test("/worktree-add records the association; /worktree-list returns it", async () => {
  const seat = await registerSeat();
  const p = wtDir("feat");
  const add = await post("/worktree-add", { id: seat, path: p, branch: "feat", base_commit: "abc123" });
  expect(add.status).toBe(200);
  expect(((await add.json()) as { ok: boolean }).ok).toBe(true);

  const mine = (await listWorktrees(seat)).find((w) => w.seat_id === seat)!;
  expect(mine).toBeDefined();
  expect(mine.path).toBe(p);
  expect(mine.branch).toBe("feat");
  expect(mine.base_commit).toBe("abc123");
});

test("/worktree-add upserts on (seat_id, path): re-recording refreshes, never duplicates", async () => {
  const seat = await registerSeat();
  const p = wtDir("dup");
  await post("/worktree-add", { id: seat, path: p, branch: "dup", base_commit: "sha1" });
  await post("/worktree-add", { id: seat, path: p, branch: "dup", base_commit: "sha2" });
  const rows = (await listWorktrees(seat)).filter((w) => w.path === p);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.base_commit).toBe("sha2"); // refreshed
});

test("/worktree-list by id returns only that seat's; omitted returns all", async () => {
  const a = await registerSeat();
  const b = await registerSeat();
  const pa = wtDir("list-a");
  const pb = wtDir("list-b");
  await post("/worktree-add", { id: a, path: pa, branch: "a", base_commit: "x" });
  await post("/worktree-add", { id: b, path: pb, branch: "b", base_commit: "y" });

  const onlyA = await listWorktrees(a);
  expect(onlyA.every((w) => w.seat_id === a)).toBe(true);
  expect(onlyA.some((w) => w.path === pa)).toBe(true);
  expect(onlyA.some((w) => w.path === pb)).toBe(false);

  const all = await listWorktrees();
  expect(all.some((w) => w.seat_id === a && w.path === pa)).toBe(true);
  expect(all.some((w) => w.seat_id === b && w.path === pb)).toBe(true);
});

test("/worktree-remove drops the association and is idempotent; owner-scoped by seat_id+path", async () => {
  const a = await registerSeat();
  const b = await registerSeat();
  const p = wtDir("owned-by-a");
  await post("/worktree-add", { id: a, path: p, branch: "a", base_commit: "x" });
  await post("/worktree-add", { id: b, path: wtDir("owned-by-b"), branch: "b", base_commit: "y" });

  // b calling remove on a's path must NOT drop a's row (the delete is seat_id-scoped).
  expect(((await (await post("/worktree-remove", { id: b, path: p })).json()) as { ok: boolean }).ok).toBe(true);
  expect((await listWorktrees(a)).some((w) => w.path === p)).toBe(true); // a survives
  expect((await listWorktrees(b)).some((w) => w.path === p)).toBe(false);

  // a removes its own — gone; removing again is a clean no-op.
  expect(((await (await post("/worktree-remove", { id: a, path: p })).json()) as { ok: boolean }).ok).toBe(true);
  expect(((await (await post("/worktree-remove", { id: a, path: p })).json()) as { ok: boolean }).ok).toBe(true);
  expect((await listWorktrees(a)).some((w) => w.path === p)).toBe(false);
});

// --- v0.2.7.1 Finding #2: one PATH, one seat -----------------------------------
// The v0.2.7 recovery regression: the table's PK is (seat_id, path), so nothing in the
// schema stopped a second seat from claiming a path another seat already owned. Two
// seats in one git tree means either `checkpoint` can remove it under the other.

test("/worktree-add REJECTS a path already owned by a DIFFERENT seat; the owner's row is untouched", async () => {
  const a = await registerSeat({ name: "owner-a" });
  const b = await registerSeat({ name: "intruder-b" });
  const p = wtDir("contested");
  expect(((await (await post("/worktree-add", { id: a, path: p, branch: "a", base_commit: "x" })).json()) as { ok: boolean }).ok).toBe(true);

  const stolen = await post("/worktree-add", { id: b, path: p, branch: "b", base_commit: "y" });
  const body = (await stolen.json()) as { ok: boolean; error?: string };
  expect(body.ok).toBe(false);
  expect(body.error).toContain("already owned by");
  expect(body.error).toContain("owner-a"); // names the owner, not just the slug

  expect((await listWorktrees(b)).some((w) => w.path === p)).toBe(false); // no row for b
  const mine = (await listWorktrees(a)).find((w) => w.path === p)!;
  expect(mine).toBeDefined(); // a's association intact...
  expect(mine.branch).toBe("a"); // ...and unchanged
});

test("/worktree-add stays an idempotent upsert for the SAME seat re-adding its own path", async () => {
  const a = await registerSeat();
  const p = wtDir("self-readd");
  await post("/worktree-add", { id: a, path: p, branch: "s", base_commit: "sha1" });
  const again = await post("/worktree-add", { id: a, path: p, branch: "s", base_commit: "sha2" });
  expect(((await again.json()) as { ok: boolean }).ok).toBe(true);
  const rows = (await listWorktrees(a)).filter((w) => w.path === p);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.base_commit).toBe("sha2");
});

test("endSeat drops a seat's worktree ASSOCIATIONS (git tree never touched)", async () => {
  // Register LIVE, record two worktrees, then /unregister → endSeat reaps the rows.
  const reg = await post("/register", { pid: alivePid(), cwd: "/tmp/wt-dead", git_root: null, tty: null, summary: "dying", role: "ghost", model: null });
  const dead = ((await reg.json()) as { id: string }).id;
  await post("/worktree-add", { id: dead, path: wtDir("dead-1"), branch: "d1", base_commit: "x" });
  await post("/worktree-add", { id: dead, path: wtDir("dead-2"), branch: "d2", base_commit: "y" });
  expect(await listWorktrees(dead)).toHaveLength(2);

  await post("/unregister", { id: dead });
  expect(await listWorktrees(dead)).toHaveLength(0); // associations reaped with the seat
});

test("/worktree-add for a non-live seat is refused cleanly; malformed input is 400", async () => {
  const unknown = await post("/worktree-add", { id: "zzzzzzzz", path: "/wt/x", branch: "x", base_commit: "s" });
  expect(unknown.status).toBe(200);
  expect(((await unknown.json()) as { ok: boolean }).ok).toBe(false);

  expect((await post("/worktree-add", { id: "bad", path: "/p", branch: "b", base_commit: "s" })).status).toBe(400);
  const seat = await registerSeat();
  expect((await post("/worktree-add", { id: seat, path: "", branch: "b", base_commit: "s" })).status).toBe(400);
  expect((await post("/worktree-add", { id: seat, path: "/p", branch: "", base_commit: "s" })).status).toBe(400);
  expect((await post("/worktree-remove", { id: "bad", path: "/p" })).status).toBe(400);
});

// --- v0.2.9 path aliasing: one tree, one owner, whatever you call it -----------
// The 3rd-review finding. worktreeAddTxn compared raw path TEXT, so four spellings of one
// directory registered as four different paths — which restores the two-seats-one-worktree
// bug 0.2.8 closed for a single spelling. Every alias below must resolve to ONE owner.

describe("path canonicalization (v0.2.9)", () => {
  // `${base}/wt` plus three aliases of it: a trailing slash, a ".." hop through a sibling,
  // and a symlink. `x` must exist for the ".." form to resolve.
  function aliasSet(name: string): { canonical: string; aliases: string[] } {
    const base = wtDir(name);
    const canonical = realpathSync(join(base, "wt"));
    mkdirSync(join(base, "x"), { recursive: true });
    symlinkSync(canonical, join(base, "link"));
    return { canonical, aliases: [canonical, `${canonical}/`, join(base, "x", "..", "wt"), join(base, "link")] };
  }
  // mkdirSync the nested dir the helper above assumes.
  function makeAliasBase(name: string): { canonical: string; aliases: string[] } {
    mkdirSync(join(WT_ROOT, name, "wt"), { recursive: true });
    return aliasSet(name);
  }

  test("every alias of one directory records ONE association under the canonical path", async () => {
    const seat = await registerSeat();
    const { canonical, aliases } = makeAliasBase("alias-one");
    for (const [i, a] of aliases.entries()) {
      const res = await post("/worktree-add", { id: seat, path: a, branch: "aliased", base_commit: `sha${i}` });
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    }
    // Four adds, four spellings, ONE row — and it is stored canonically.
    const rows = (await listWorktrees(seat)).filter((w) => w.path === canonical);
    expect(rows).toHaveLength(1);
    expect((await listWorktrees(seat)).filter((w) => w.branch === "aliased")).toHaveLength(1);
  });

  test("a second seat is REFUSED through EVERY alias of a path the first seat owns", async () => {
    const a = await registerSeat({ name: "alias-owner" });
    const b = await registerSeat({ name: "alias-intruder" });
    const { canonical, aliases } = makeAliasBase("alias-contested");
    expect(((await (await post("/worktree-add", { id: a, path: canonical, branch: "a", base_commit: "x" })).json()) as { ok: boolean }).ok).toBe(true);

    for (const alias of aliases) {
      const body = (await (await post("/worktree-add", { id: b, path: alias, branch: "b", base_commit: "y" })).json()) as {
        ok: boolean;
        error?: string;
      };
      expect(body.ok).toBe(false); // pre-0.2.9 every alias but the first slipped through
      expect(body.error).toContain("alias-owner");
    }
    expect((await listWorktrees(b)).some((w) => w.path === canonical)).toBe(false);
    expect((await listWorktrees(a)).find((w) => w.path === canonical)!.branch).toBe("a"); // untouched
  });

  test("a path that does not exist is refused (realpath is the only safe normalization)", async () => {
    const seat = await registerSeat();
    const body = (await (await post("/worktree-add", { id: seat, path: join(WT_ROOT, "no-such-tree"), branch: "n", base_commit: "x" })).json()) as {
      ok: boolean;
      error?: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("not an existing absolute path");
  });

  test("a lease and a worktree row agree on the canonical path across aliases", async () => {
    const seat = await registerSeat({ guarded: true });
    const { canonical, aliases } = makeAliasBase("alias-lease");
    await post("/worktree-add", { id: seat, path: aliases[2]!, branch: "l", base_commit: "x" }); // recorded via the ".." alias
    const lease = (await (await post("/lease-worktree", { id: seat, path: aliases[3]! })).json()) as { ok: boolean }; // leased via the symlink
    expect(lease.ok).toBe(true);
    // The lease joins onto the worktree row only if BOTH canonicalized to the same string.
    const row = (await listWorktrees(seat)).find((w) => w.path === canonical)!;
    expect((row as Wt & { lease_expires_at?: string | null }).lease_expires_at).toBeTruthy();
  });
});

// --- v0.2.9 checkpoint lease --------------------------------------------------

describe("/lease-worktree + /release-worktree", () => {
  async function lease(id: string, path: string) {
    return (await (await post("/lease-worktree", { id, path })).json()) as { ok: boolean; expires_at?: string; error?: string };
  }

  test("acquire → renew → release round-trips; the row is visible while held", async () => {
    const seat = await registerSeat();
    const p = wtDir("lease-round-trip");
    await post("/worktree-add", { id: seat, path: p, branch: "r", base_commit: "x" });

    const first = await lease(seat, p);
    expect(first.ok).toBe(true);
    expect(first.expires_at).toBeTruthy();
    expect(Date.parse(first.expires_at!)).toBeGreaterThan(Date.now()); // TTL is in the future
    expect(leaseRow(p)).not.toBeNull();

    // Re-leasing by the HOLDER renews rather than refusing — a checkpoint that re-acquires
    // must not deadlock against itself.
    const renew = await lease(seat, p);
    expect(renew.ok).toBe(true);
    expect(Date.parse(renew.expires_at!)).toBeGreaterThanOrEqual(Date.parse(first.expires_at!));
    expect(leaseRow(p)!.seat_id).toBe(seat);

    expect(((await (await post("/release-worktree", { id: seat, path: p })).json()) as { ok: boolean }).ok).toBe(true);
    expect(leaseRow(p)).toBeNull();
    // Idempotent: releasing a lease nobody holds is a clean no-op (checkpoint releases
    // from a `finally`, including paths where the acquire never succeeded).
    expect(((await (await post("/release-worktree", { id: seat, path: p })).json()) as { ok: boolean }).ok).toBe(true);
  });

  test("a SECOND seat is refused while the lease is held, and the holder is named", async () => {
    const a = await registerSeat({ name: "lease-holder" });
    const b = await registerSeat({ name: "lease-rival" });
    const p = wtDir("lease-contested");
    expect((await lease(a, p)).ok).toBe(true);

    const denied = await lease(b, p);
    expect(denied.ok).toBe(false);
    expect(denied.expires_at).toBeUndefined();
    expect(denied.error).toContain("lease-holder");
    expect(leaseRow(p)!.seat_id).toBe(a); // the holder's row is untouched

    // Released by the owner → the rival can take it.
    await post("/release-worktree", { id: a, path: p });
    expect((await lease(b, p)).ok).toBe(true);
    expect(leaseRow(p)!.seat_id).toBe(b);
  });

  test("release is owner-scoped: a non-holder cannot release someone else's lease", async () => {
    const a = await registerSeat();
    const b = await registerSeat();
    const p = wtDir("lease-owner-scope");
    await lease(a, p);
    await post("/release-worktree", { id: b, path: p }); // b is not the holder
    expect(leaseRow(p)!.seat_id).toBe(a); // still held
  });

  test("an EXPIRED lease blocks nobody (a killed checkpoint must not wedge a seat)", async () => {
    const a = await registerSeat();
    const b = await registerSeat();
    const p = wtDir("lease-expired");
    expect((await lease(a, p)).ok).toBe(true);
    expireLease(p); // simulate the TTL burning down without waiting 120s

    const takeover = await lease(b, p);
    expect(takeover.ok).toBe(true);
    expect(leaseRow(p)!.seat_id).toBe(b); // ownership moved to the live claimant
  });

  test("endSeat drops the seat's leases (a lease must never outlive its holder)", async () => {
    const reg = await post("/register", { pid: alivePid(), cwd: "/tmp/wt-lease-dead", git_root: null, tty: null, summary: "dying", role: null, model: null });
    const dead = ((await reg.json()) as { id: string }).id;
    const p = wtDir("lease-dead-seat");
    expect((await lease(dead, p)).ok).toBe(true);
    expect(leaseRow(p)).not.toBeNull();

    await post("/unregister", { id: dead });
    expect(leaseRow(p)).toBeNull();
  });

  test("a non-live seat cannot lease; malformed input is 400", async () => {
    const p = wtDir("lease-validate");
    const unknown = await lease("zzzzzzzz", p);
    expect(unknown.ok).toBe(false);
    expect((await post("/lease-worktree", { id: "bad", path: p })).status).toBe(400);
    expect((await post("/lease-worktree", { id: "zzzzzzzz", path: "" })).status).toBe(400);
    expect((await post("/release-worktree", { id: "bad", path: p })).status).toBe(400);
  });
});

// --- v0.2.9 `guarded` round-trip ----------------------------------------------

test("guarded round-trips register → /list-seats; absent reads as NOT guarded", async () => {
  const on = await registerSeat({ guarded: true });
  const off = await registerSeat({ guarded: false });
  const silent = await registerSeat(); // pre-0.2.9 launcher: no field at all

  const seats = (await (await post("/list-seats", { scope: "machine", cwd: "/tmp", git_root: null })).json()) as (Seat & {
    guarded?: boolean;
  })[];
  const find = (id: string) => seats.find((s) => s.id === id)!;
  expect(find(on).guarded).toBe(true);
  expect(find(off).guarded).toBe(false);
  expect(find(silent).guarded).toBe(false); // never undefined — checkpoint branches on it
});

// --- /diff route (real git, byte-bounded) ------------------------------------

type DiffResp = { diff: string; truncated: boolean };
async function diffOf(id: string): Promise<DiffResp> {
  return (await (await post("/diff", { id })).json()) as DiffResp;
}

describe("/diff (per-seat working diff)", () => {
  test("diffs the seat's cwd when no worktree is tracked; includes staged + unstaged vs HEAD", async () => {
    const repo = makeRepo(false); // primary on main, f.txt committed as "base"
    try {
      sh(["sh", "-c", `printf 'UNSTAGED_MARKER\\n' > "${repo}/f.txt"`]); // modify tracked (unstaged)
      sh(["sh", "-c", `printf 'STAGED_MARKER\\n' > "${repo}/g.txt"`]);
      git(repo, "add", "g.txt"); // new file, staged → only in `diff HEAD`, not plain `diff`
      const seat = await registerSeat({ cwd: repo, git_root: repo });

      const res = await diffOf(seat);
      expect(res.truncated).toBe(false);
      expect(res.diff).toContain("UNSTAGED_MARKER"); // working-tree change
      expect(res.diff).toContain("STAGED_MARKER");   // staged change (proves `diff HEAD`)
      expect(res.diff).toContain("f.txt");
      expect(res.diff).toContain("g.txt");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("diffs the tracked worktree path, not the seat's cwd, when a worktree is recorded", async () => {
    const repo = makeRepo(false);
    const wtPath = join(repo, ".claude/worktrees/wt");
    try {
      const base = git(repo, "rev-parse", "main").out.trim();
      git(repo, "worktree", "add", "-q", "-b", "wtbranch", wtPath, "main");
      // Divergent uncommitted edits in each tree, so the returned diff names its source.
      sh(["sh", "-c", `printf 'CWD_MARKER\\n' > "${repo}/f.txt"`]);
      sh(["sh", "-c", `printf 'WORKTREE_MARKER\\n' > "${wtPath}/f.txt"`]);

      const seat = await registerSeat({ cwd: repo, git_root: repo });
      await post("/worktree-add", { id: seat, path: wtPath, branch: "wtbranch", base_commit: base });

      const res = await diffOf(seat);
      expect(res.diff).toContain("WORKTREE_MARKER"); // worktree path wins
      expect(res.diff).not.toContain("CWD_MARKER");  // cwd is NOT what was diffed
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a huge diff is truncated at the byte cap with the flag set", async () => {
    const CAP = 256 * 1024;
    const repo = makeRepo(false);
    try {
      // A staged new file whose diff exceeds the cap: ~400 KiB of '+' lines.
      const big = Array.from({ length: 8000 }, (_, i) => `line ${i} ${"x".repeat(48)}`).join("\n");
      await Bun.write(join(repo, "big.txt"), big);
      git(repo, "add", "big.txt");
      const seat = await registerSeat({ cwd: repo, git_root: repo });

      const res = await diffOf(seat);
      expect(res.truncated).toBe(true);
      expect(res.diff.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(res.diff, "utf8")).toBeLessThanOrEqual(CAP);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("includes UNTRACKED (new, unstaged) files a seat created — not just tracked changes", async () => {
    const repo = makeRepo(false); // HEAD exists (f.txt committed); no tracked changes below
    try {
      // A brand-new file that was never `git add`ed: absent from `git diff HEAD`, so
      // without the untracked pass this seat would show "no changes".
      sh(["sh", "-c", `printf 'UNTRACKED_MARKER\\n' > "${repo}/newfile.txt"`]);
      const seat = await registerSeat({ cwd: repo, git_root: repo });

      const res = await diffOf(seat);
      expect(res.truncated).toBe(false);      // one tiny file, well under the cap
      expect(res.diff).toContain("newfile.txt");     // the untracked path appears
      expect(res.diff).toContain("UNTRACKED_MARKER"); // and its content
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a non-repo cwd returns an empty diff, not an error", async () => {
    const notRepo = mkdtempSync(join(tmpdir(), "patrol-nonrepo-"));
    try {
      const seat = await registerSeat({ cwd: notRepo, git_root: null });
      const res = await post("/diff", { id: seat });
      expect(res.status).toBe(200); // graceful, never a 500
      const body = (await res.json()) as DiffResp;
      expect(body.diff).toBe("");
      expect(body.truncated).toBe(false);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  test("an unknown seat returns an empty diff; a malformed id is 400", async () => {
    const unknown = await diffOf("zzzzzzzz"); // slug-shaped but no such seat
    expect(unknown.diff).toBe("");
    expect(unknown.truncated).toBe(false);
    expect((await post("/diff", { id: "bad" })).status).toBe(400); // not an 8-char slug
  });
});

// --- pure command-sequence unit tests ----------------------------------------

describe("worktree git sequence (pure)", () => {
  test("worktreeDirSegment folds a branch into one safe path segment", () => {
    expect(worktreeDirSegment("clean")).toBe("clean");
    expect(worktreeDirSegment("feat/foo bar")).toBe("feat-foo-bar");
    expect(worktreeDirSegment("a//b__c")).toBe("a-b__c"); // '/' collapses, '_' kept
    expect(worktreeDirSegment("--edge--")).toBe("edge"); // edge dashes trimmed
    expect(worktreeDirSegment("///")).toBe("wt"); // empty result -> fallback
  });

  test("worktreeAddArgs is the exact `git worktree add -b` argv", () => {
    expect(worktreeAddArgs("/repo/.claude/worktrees/feat", "feat", "main")).toEqual([
      "worktree", "add", "-b", "feat", "/repo/.claude/worktrees/feat", "main",
    ]);
  });
});

describe("classifyExistingWorktree (pure — the add-failure recovery decision)", () => {
  const porcelain =
    "worktree /repo\nHEAD aaaa\nbranch refs/heads/main\n\n" +
    "worktree /repo/.claude/worktrees/feat\nHEAD bbbb\nbranch refs/heads/feat\n";

  test("same path + same branch → match (idempotent recovery: proceed to broker upsert)", () => {
    expect(classifyExistingWorktree(porcelain, "/repo/.claude/worktrees/feat", "feat")).toBe("match");
  });
  test("same path + different branch → mismatch (a real conflict: reject)", () => {
    expect(classifyExistingWorktree(porcelain, "/repo/.claude/worktrees/feat", "other")).toBe("mismatch");
  });
  test("no worktree at path → absent (add failed for another reason: reject)", () => {
    expect(classifyExistingWorktree(porcelain, "/repo/.claude/worktrees/nope", "feat")).toBe("absent");
  });
  test("a detached worktree at the path → mismatch (no branch to match)", () => {
    expect(classifyExistingWorktree("worktree /repo/wt\nHEAD cccc\ndetached\n", "/repo/wt", "feat")).toBe("mismatch");
  });
});

describe("checkpointPlan (pure — the dangerous merge-back path, asserted without running git)", () => {
  // mergeRef is the pinned pre-gate SHA, not the branch name — merging the exact
  // snapshot is what makes the "did the seat commit during checkpoint?" check sound.
  const SNAP = "abc123def456";
  const plan = checkpointPlan({ repo: "/repo", intPath: "/tmp/int/trunk", seatPath: "/repo/.claude/worktrees/feat", mergeRef: SNAP });

  test("the integration worktree checks out the trunk as a BRANCH (not --detach)", () => {
    // Checking out `main` as a branch is what lets the merge itself advance
    // refs/heads/main; --detach would merge a detached head and leave main behind.
    expect(plan.integrationAdd).toEqual(["-C", "/repo", "worktree", "add", "/tmp/int/trunk", TRUNK]);
    expect(plan.integrationAdd).not.toContain("--detach");
  });

  test("the merge pins the snapshot SHA (never the branch name) and runs ONLY inside the integration worktree", () => {
    expect(plan.merge).toEqual(["-C", "/tmp/int/trunk", "merge", "--no-edit", SNAP]);
    expect(plan.mergeAbort).toEqual(["-C", "/tmp/int/trunk", "merge", "--abort"]);
    // Every mutating merge command targets the isolated tree, never -C /repo or the seat path.
    for (const argv of [plan.merge, plan.mergeAbort]) {
      const cDir = argv[argv.indexOf("-C") + 1];
      expect(cDir).toBe("/tmp/int/trunk");
    }
  });

  test("no command mutates a tree we don't own (no checkout/reset/update-ref anywhere)", () => {
    const all = [plan.integrationAdd, plan.merge, plan.mergeAbort, plan.resolveHead, plan.integrationRemove, plan.seatRemove].flat();
    for (const banned of ["checkout", "reset", "update-ref"]) {
      expect(all).not.toContain(banned);
    }
  });

  test("the resulting trunk commit is read from the integration worktree", () => {
    expect(plan.resolveHead).toEqual(["-C", "/tmp/int/trunk", "rev-parse", "HEAD"]);
  });

  test("cleanup: integration tree is force-removed; the seat tree is removed WITHOUT --force (no forced loss of uncommitted work)", () => {
    expect(plan.integrationRemove).toEqual(["-C", "/repo", "worktree", "remove", "--force", "/tmp/int/trunk"]);
    expect(plan.seatRemove).toEqual(["-C", "/repo", "worktree", "remove", "/repo/.claude/worktrees/feat"]);
    expect(plan.seatRemove).not.toContain("--force");
  });
});

// --- one real end-to-end smoke (drives the CLI + real git) --------------------

describe("end-to-end (real git repo, real CLI subprocess)", () => {
  test("worktree creates + records, gate-false aborts, gate-true merges + removes", async () => {
    const repo = makeRepo(true); // primary detached → trunk free (the correct fleet layout)
    const env = { CLAUDE_PATROL_PORT: String(PORT), CLAUDE_PATROL_SECRET_FILE: SECRET_FILE };
    const seat = await registerGuardedSeat({ cwd: repo, git_root: repo, handle: "e2e-builder" });
    const mainBefore = git(repo, "rev-parse", "main").out.trim();

    try {
      // 1. patrol worktree — creates the tree and records the association.
      const wt = sh(["bun", CLI, "worktree", seat, "feat", "--base", "main"], repo, env);
      expect(wt.code).toBe(0);
      const wtPath = wt.out.trim();
      expect(wtPath).toBe(join(repo, ".claude/worktrees/feat"));
      expect(existsSync(wtPath)).toBe(true);
      const recorded = await listWorktrees(seat);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.branch).toBe("feat");
      expect(recorded[0]!.base_commit).toBe(mainBefore); // resolved base SHA

      // advance feat past main so the merge-back is a real fast-forward
      sh(["sh", "-c", `echo work > "${wtPath}/f.txt"`]);
      git(wtPath, "commit", "-qam", "seat work");
      const featTip = git(wtPath, "rev-parse", "HEAD").out.trim();
      expect(featTip).not.toBe(mainBefore);

      // 2. checkpoint --gate "false" — the gate fails, so NOTHING merges.
      const bad = sh(["bun", CLI, "checkpoint", seat, "--gate", "false"], repo, env);
      expect(bad.code).not.toBe(0);
      expect(git(repo, "rev-parse", "main").out.trim()).toBe(mainBefore); // main untouched
      expect(existsSync(wtPath)).toBe(true); // worktree left intact
      expect(await listWorktrees(seat)).toHaveLength(1); // association kept

      // 3. checkpoint --gate "true" — gate passes, feat fast-forwards onto main,
      //    the worktree is removed and de-registered.
      const good = sh(["bun", CLI, "checkpoint", seat, "--gate", "true"], repo, env);
      expect(good.code).toBe(0);
      expect(good.out).toContain(`merged feat into ${TRUNK}`);
      expect(git(repo, "rev-parse", "main").out.trim()).toBe(featTip); // main advanced to feat tip
      expect(existsSync(wtPath)).toBe(false); // seat worktree removed
      expect(await listWorktrees(seat)).toHaveLength(0); // de-registered
      // branch left in place (removing a branch is out of scope)
      expect(git(repo, "rev-parse", "--verify", "feat").code).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("checkpoint STOPs on a merge conflict — never auto-resolves; main stays put, worktree intact", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "patrol-repo-")));
    const env = { CLAUDE_PATROL_PORT: String(PORT), CLAUDE_PATROL_SECRET_FILE: SECRET_FILE };
    sh(["git", "init", "-q", "-b", "main", repo]);
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    sh(["sh", "-c", `echo base > "${repo}/f.txt"`]);
    git(repo, "add", "f.txt");
    git(repo, "commit", "-qm", "base");
    const c0 = git(repo, "rev-parse", "HEAD").out.trim();

    // feat and main edit the SAME line divergently → a guaranteed merge conflict.
    git(repo, "branch", "feat");
    const wtPath = join(repo, ".claude/worktrees/feat");
    git(repo, "worktree", "add", "-q", wtPath, "feat");
    sh(["sh", "-c", `echo featside > "${wtPath}/f.txt"`]);
    git(wtPath, "commit", "-qam", "feat edit");
    sh(["sh", "-c", `echo mainside > "${repo}/f.txt"`]);
    git(repo, "commit", "-qam", "main edit");
    git(repo, "checkout", "-q", "--detach"); // free the trunk so the interlock isn't what stops us

    const seat = await registerGuardedSeat({ cwd: repo, git_root: repo, handle: "e2e-conflict" });
    await post("/worktree-add", { id: seat, path: wtPath, branch: "feat", base_commit: c0 });
    const mainBefore = git(repo, "rev-parse", "main").out.trim();

    try {
      const cp = sh(["bun", CLI, "checkpoint", seat, "--gate", "true"], repo, env);
      expect(cp.code).not.toBe(0); // conflict → STOP, not a resolution
      expect(cp.err.toLowerCase()).toContain("failed");
      expect(git(repo, "rev-parse", "main").out.trim()).toBe(mainBefore); // trunk ref never moved
      expect(existsSync(wtPath)).toBe(true); // work preserved
      expect(await listWorktrees(seat)).toHaveLength(1); // association kept
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("checkpoint REFUSES to merge when the trunk is a live checkout (never mutates a tree it doesn't own)", async () => {
    const repo = makeRepo(false); // primary STAYS on main → trunk is a live checkout
    const env = { CLAUDE_PATROL_PORT: String(PORT), CLAUDE_PATROL_SECRET_FILE: SECRET_FILE };
    const seat = await registerGuardedSeat({ cwd: repo, git_root: repo, handle: "e2e-guard" });
    const mainBefore = git(repo, "rev-parse", "main").out.trim();

    try {
      const wt = sh(["bun", CLI, "worktree", seat, "feat2", "--base", "main"], repo, env);
      expect(wt.code).toBe(0);
      const wtPath = wt.out.trim();
      sh(["sh", "-c", `echo work > "${wtPath}/f.txt"`]);
      git(wtPath, "commit", "-qam", "seat work");

      const cp = sh(["bun", CLI, "checkpoint", seat, "--gate", "true"], repo, env);
      expect(cp.code).not.toBe(0); // safe STOP: the integration worktree add is refused
      expect(cp.err).toContain(TRUNK);
      expect(git(repo, "rev-parse", "main").out.trim()).toBe(mainBefore); // main NOT advanced
      expect(existsSync(wtPath)).toBe(true); // work preserved
      expect(await listWorktrees(seat)).toHaveLength(1); // association kept
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("checkpoint STOPs when the seat advances the branch DURING checkpoint (no false success)", async () => {
    // The race Codex #3 closes: a standing seat commits after the pre-gate snapshot but
    // before worktree-removal. A gate that itself commits is a deterministic stand-in for
    // that commit (it runs in the seat's tree, after the snapshot). The checkpoint must
    // STOP — not remove the tree, not deregister, not falsely advance main past the snapshot.
    const repo = makeRepo(true); // detached primary → trunk free (rules out the live-checkout STOP)
    const env = { CLAUDE_PATROL_PORT: String(PORT), CLAUDE_PATROL_SECRET_FILE: SECRET_FILE };
    const seat = await registerGuardedSeat({ cwd: repo, git_root: repo, handle: "e2e-advance" });
    const mainBefore = git(repo, "rev-parse", "main").out.trim();
    try {
      const wt = sh(["bun", CLI, "worktree", seat, "adv", "--base", "main"], repo, env);
      expect(wt.code).toBe(0);
      const wtPath = wt.out.trim();

      // First commit — the tip the checkpoint snapshots.
      sh(["sh", "-c", `echo one > "${wtPath}/f.txt"`]);
      git(wtPath, "commit", "-qam", "seat work 1");
      const snapTip = git(wtPath, "rev-parse", "HEAD").out.trim();

      // The gate commits a SECOND time, advancing the branch after the snapshot.
      const gate = `echo two > f.txt && git commit -qam seatwork2`;
      const cp = sh(["bun", CLI, "checkpoint", seat, "--gate", gate], repo, env);

      expect(cp.code).not.toBe(0); // STOP, not a false success
      expect(cp.err.toLowerCase()).toContain("advanced"); // reports the advance
      expect(existsSync(wtPath)).toBe(true); // worktree intact
      expect(await listWorktrees(seat)).toHaveLength(1); // association intact

      const branchTip = git(wtPath, "rev-parse", "HEAD").out.trim();
      expect(branchTip).not.toBe(snapTip); // the gate really did advance the branch
      // main NOT falsely advanced past the snapshot: the after-gate STOP merged nothing.
      const mainNow = git(repo, "rev-parse", "main").out.trim();
      expect(mainNow).toBe(mainBefore);
      expect(mainNow).not.toBe(branchTip); // the newer commit is unmerged into main
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("worktree add-fails-because-exists → idempotent recovery still records the association", async () => {
    // Codex #8: a prior run created the tree but the broker POST failed; the tree is now
    // untracked. Re-running dies at `git worktree add` (branch/path exists). Recovery must
    // detect the matching existing worktree and still run the broker upsert.
    const repo = makeRepo(true); // detached primary so `worktree add ... main` isn't blocked
    const env = { CLAUDE_PATROL_PORT: String(PORT), CLAUDE_PATROL_SECRET_FILE: SECRET_FILE };
    const seat = await registerGuardedSeat({ cwd: repo, git_root: repo, handle: "e2e-recover" });
    try {
      // Pre-create the EXACT worktree the CLI would create, with NO broker record — this is
      // the post-failure state. The CLI's own `git worktree add` will then fail on it.
      const wtPath = join(repo, ".claude/worktrees/recover");
      git(repo, "worktree", "add", "-q", "-b", "recover", wtPath, "main");
      expect(existsSync(wtPath)).toBe(true);
      expect(await listWorktrees(seat)).toHaveLength(0); // nothing tracked yet

      const r = sh(["bun", CLI, "worktree", seat, "recover", "--base", "main"], repo, env);
      expect(r.code).toBe(0); // recovered, not a hard failure
      expect(r.out.trim()).toBe(wtPath); // still prints the tree path
      const recorded = await listWorktrees(seat);
      expect(recorded).toHaveLength(1); // the broker upsert ran despite the add failing
      expect(recorded[0]!.path).toBe(wtPath);
      expect(recorded[0]!.branch).toBe("recover");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("checkpoint STOPs when the seat SWITCHED BRANCHES during checkpoint (HEAD binding, not just the branch name)", async () => {
    // Binding only to the recorded branch name misses this: the seat checks out a new
    // branch and commits there, so refs/heads/<recorded> never moves and every SHA check
    // would pass — while the work sits on a ref checkpoint never merges. The gate is a
    // deterministic stand-in for the switch (it runs in the seat's tree, after the snapshot).
    const repo = makeRepo(true);
    const env = { CLAUDE_PATROL_PORT: String(PORT), CLAUDE_PATROL_SECRET_FILE: SECRET_FILE };
    const seat = await registerGuardedSeat({ cwd: repo, git_root: repo, handle: "e2e-switch" });
    const mainBefore = git(repo, "rev-parse", "main").out.trim();
    try {
      const wtPath = sh(["bun", CLI, "worktree", seat, "swit", "--base", "main"], repo, env).out.trim();
      sh(["sh", "-c", `echo one > "${wtPath}/f.txt"`]);
      git(wtPath, "commit", "-qam", "seat work 1");
      const switTip = git(wtPath, "rev-parse", "swit").out.trim();

      // The gate switches branches and commits THERE — `swit` stays exactly where pinned.
      const gate = `git checkout -q -b elsewhere && echo two > f.txt && git commit -qam sidework`;
      const cp = sh(["bun", CLI, "checkpoint", seat, "--gate", gate], repo, env);

      expect(cp.code).not.toBe(0); // STOP
      expect(cp.err).toContain("switched branches");
      expect(git(wtPath, "rev-parse", "swit").out.trim()).toBe(switTip); // recorded branch never moved...
      expect(cp.err).toContain("nothing was merged"); // ...and we stopped BEFORE the merge
      expect(git(repo, "rev-parse", "main").out.trim()).toBe(mainBefore); // trunk untouched
      expect(existsSync(wtPath)).toBe(true); // tree intact
      expect(await listWorktrees(seat)).toHaveLength(1); // association intact
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("checkpoint reports INCOMPLETE (no success, no deregister) when a commit lands in the FINAL window, during worktree removal", async () => {
    // The last TOCTOU window: a commit landing between the pre-remove check and
    // `git worktree remove` leaves a CLEAN tree, so removal succeeds and — before the
    // FENCE 3 re-resolve — checkpoint printed success while TRUNK held only the pinned
    // snapshot, stranding that commit. Injected DETERMINISTICALLY with a `git` shim
    // earlier on the CLI's PATH: it fires exactly once, on the seat-worktree removal
    // argv, commits on the branch, then delegates to the real git.
    const repo = makeRepo(true);
    const seatWt = join(repo, ".claude/worktrees/late");
    const shimDir = mkdtempSync(join(tmpdir(), "patrol-gitshim-"));
    const marker = join(shimDir, "armed");
    writeFileSync(marker, "1");
    writeFileSync(
      join(shimDir, "git"),
      `#!/bin/sh\n` +
        `if [ -f "${marker}" ] && [ "$*" = "-C ${repo} worktree remove ${seatWt}" ]; then\n` +
        `  rm -f "${marker}"\n` +
        `  echo late > "${seatWt}/f.txt"\n` +
        `  "${REAL_GIT}" -C "${seatWt}" commit -qam late-commit >/dev/null 2>&1\n` +
        `fi\n` +
        `exec "${REAL_GIT}" "$@"\n`,
      { mode: 0o755 }
    );
    const env = { CLAUDE_PATROL_PORT: String(PORT), CLAUDE_PATROL_SECRET_FILE: SECRET_FILE, PATH: `${shimDir}:${process.env.PATH}` };
    const seat = await registerGuardedSeat({ cwd: repo, git_root: repo, handle: "e2e-late" });
    try {
      const wtPath = sh(["bun", CLI, "worktree", seat, "late", "--base", "main"], repo, env).out.trim();
      expect(wtPath).toBe(seatWt);
      sh(["sh", "-c", `echo one > "${wtPath}/f.txt"`]);
      git(wtPath, "commit", "-qam", "seat work 1");
      const snapTip = git(repo, "rev-parse", "late").out.trim();

      const cp = sh(["bun", CLI, "checkpoint", seat, "--gate", "true"], repo, env);

      expect(existsSync(marker)).toBe(false); // the shim really fired
      expect(cp.code).not.toBe(0); // NOT a success
      expect(cp.err).toContain("INCOMPLETE");
      expect(cp.out).not.toContain("removed worktree"); // no success print
      expect(await listWorktrees(seat)).toHaveLength(1); // NOT deregistered

      // The merge itself was correct and nothing is lost: trunk holds the pinned snapshot,
      // and the branch still holds the later commit even though the tree is gone.
      expect(existsSync(wtPath)).toBe(false); // removal did succeed (clean tree)
      expect(git(repo, "rev-parse", "main").out.trim()).toBe(snapTip);
      const lateTip = git(repo, "rev-parse", "late").out.trim();
      expect(lateTip).not.toBe(snapTip);
      expect(cp.err).toContain(lateTip.slice(0, 12)); // reports pinned → current
      expect(cp.err).toContain(snapTip.slice(0, 12));
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  test("two seats CANNOT share one worktree: recovery for a second seat is REFUSED and the owner's association survives", async () => {
    // v0.2.7 regression (Finding #2): recovery treated ANY `worktree add` failure with a
    // matching path+branch as recoverable, so seat B re-running against seat A's tree
    // attached a SECOND seat to it — both work in one tree, and either checkpoint can
    // remove it under the other. Both halves must refuse: the CLI names the owner, and
    // the broker rejects the write even if a client bypasses the CLI.
    const repo = makeRepo(true);
    const env = { CLAUDE_PATROL_PORT: String(PORT), CLAUDE_PATROL_SECRET_FILE: SECRET_FILE };
    const a = await registerGuardedSeat({ cwd: repo, git_root: repo, handle: "e2e-own-a" });
    const b = await registerGuardedSeat({ cwd: repo, git_root: repo, handle: "e2e-own-b" });
    try {
      const first = sh(["bun", CLI, "worktree", a, "shared", "--base", "main"], repo, env);
      expect(first.code).toBe(0);
      const wtPath = first.out.trim();

      // B re-runs the same command: `git worktree add` fails (path+branch exist), which is
      // exactly the state the recovery path handles — but the path belongs to A.
      const second = sh(["bun", CLI, "worktree", b, "shared", "--base", "main"], repo, env);
      expect(second.code).not.toBe(0);
      expect(second.err).toContain(a); // names the owning seat
      expect(second.err.toLowerCase()).toContain("refusing");

      expect(await listWorktrees(b)).toHaveLength(0); // B never got an association
      const owned = await listWorktrees(a);
      expect(owned).toHaveLength(1); // A's is intact
      expect(owned[0]!.path).toBe(wtPath);
      expect(owned[0]!.branch).toBe("shared");

      // And the broker refuses it directly, not only via the CLI's pre-check.
      const direct = await post("/worktree-add", { id: b, path: wtPath, branch: "shared", base_commit: owned[0]!.base_commit });
      expect(((await direct.json()) as { ok: boolean }).ok).toBe(false);
      expect(await listWorktrees(b)).toHaveLength(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("worktree add-fails with a MISMATCH (different branch at the path) → rejected, no upsert", async () => {
    // The guard rails: recovery only kicks in on an exact path+branch match. A different
    // branch already checked out at the target path is a real conflict — reject, don't clobber.
    const repo = makeRepo(true);
    const env = { CLAUDE_PATROL_PORT: String(PORT), CLAUDE_PATROL_SECRET_FILE: SECRET_FILE };
    const seat = await registerGuardedSeat({ cwd: repo, git_root: repo, handle: "e2e-mismatch" });
    try {
      // Occupy the path the CLI derives for branch "wanted" with a DIFFERENT branch.
      const wtPath = join(repo, ".claude/worktrees/wanted");
      git(repo, "worktree", "add", "-q", "-b", "squatter", wtPath, "main");

      const r = sh(["bun", CLI, "worktree", seat, "wanted", "--base", "main"], repo, env);
      expect(r.code).not.toBe(0); // rejected — the path holds a different branch
      expect(await listWorktrees(seat)).toHaveLength(0); // no association recorded
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // --- v0.2.9: the lease is what makes the merge safe, so assert it is real ---------

  test("checkpoint REFUSES an UNGUARDED seat; --force proceeds", async () => {
    const repo = makeRepo(true);
    const env = { CLAUDE_PATROL_PORT: String(PORT), CLAUDE_PATROL_SECRET_FILE: SECRET_FILE };
    const seat = await registerSeat({ cwd: repo, git_root: repo }); // NO guard hook installed
    const mainBefore = git(repo, "rev-parse", "main").out.trim();
    try {
      const wtPath = sh(["bun", CLI, "worktree", seat, "unguarded", "--base", "main"], repo, env).out.trim();
      sh(["sh", "-c", `echo work > "${wtPath}/f.txt"`]);
      git(wtPath, "commit", "-qam", "seat work");
      const tip = git(wtPath, "rev-parse", "HEAD").out.trim();

      // An unguarded seat cannot be quiesced, so a checkpoint would be back to racing it.
      const refused = sh(["bun", CLI, "checkpoint", seat, "--gate", "true"], repo, env);
      expect(refused.code).not.toBe(0);
      expect(refused.err).toContain("not a guarded seat");
      expect(git(repo, "rev-parse", "main").out.trim()).toBe(mainBefore); // nothing merged
      expect(existsSync(wtPath)).toBe(true);
      expect(await listWorktrees(seat)).toHaveLength(1); // still tracked

      // --force is the documented escape hatch: it waives ONLY the guard requirement.
      const forced = sh(["bun", CLI, "checkpoint", seat, "--gate", "true", "--force"], repo, env);
      expect(forced.code).toBe(0);
      expect(git(repo, "rev-parse", "main").out.trim()).toBe(tip);
      expect(await listWorktrees(seat)).toHaveLength(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a guarded seat with NO lease_file is treated as unguarded (never guess the path)", async () => {
    const repo = makeRepo(true);
    const env = { CLAUDE_PATROL_PORT: String(PORT), CLAUDE_PATROL_SECRET_FILE: SECRET_FILE };
    // The half-wired case: the hook is installed but the seat never reported where its lease
    // file lives. Writing a guessed path would leave the hook watching a different file — the
    // lease would look taken while quiescing nothing, which is worse than refusing outright.
    const seat = await registerSeat({ cwd: repo, git_root: repo, guarded: true });
    const mainBefore = git(repo, "rev-parse", "main").out.trim();
    try {
      const wtPath = sh(["bun", CLI, "worktree", seat, "nofile", "--base", "main"], repo, env).out.trim();
      sh(["sh", "-c", `echo work > "${wtPath}/f.txt"`]);
      git(wtPath, "commit", "-qam", "seat work");

      const cp = sh(["bun", CLI, "checkpoint", seat, "--gate", "true"], repo, env);
      expect(cp.code).not.toBe(0);
      expect(cp.err).toContain("no lease-file path");
      expect(git(repo, "rev-parse", "main").out.trim()).toBe(mainBefore); // nothing merged
      expect(await listWorktrees(seat)).toHaveLength(1); // still tracked
      expect(leaseRow(wtPath)).toBeNull(); // refused BEFORE acquiring
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a guarded checkpoint HOLDS the lease across the merge and releases it after", async () => {
    const repo = makeRepo(true);
    const env = { CLAUDE_PATROL_PORT: String(PORT), CLAUDE_PATROL_SECRET_FILE: SECRET_FILE };
    const leaseFile = join(WT_ROOT, "held-lease.json");
    const seat = await registerSeat({ cwd: repo, git_root: repo, guarded: true, lease_file: leaseFile });
    try {
      const wtPath = sh(["bun", CLI, "worktree", seat, "leased", "--base", "main"], repo, env).out.trim();
      // Resolve NOW: a successful checkpoint removes this tree, after which realpath cannot.
      const canonical = realpathSync(wtPath);
      sh(["sh", "-c", `echo work > "${wtPath}/f.txt"`]);
      git(wtPath, "commit", "-qam", "seat work");

      // The gate runs INSIDE the leased window, so it is the observation point: copy the
      // lease file the guard hook would be stat-ing right now.
      const witness = join(WT_ROOT, "lease-witness.json");
      const cp = sh(["bun", CLI, "checkpoint", seat, "--gate", `cp "${leaseFile}" "${witness}"`], repo, env);
      expect(cp.code).toBe(0);

      // Mid-run: the file existed and named this tree + an expiry (what the hook reads).
      const seen = JSON.parse(readFileSync(witness, "utf8")) as { expires_at: string; path: string };
      expect(seen.path).toBe(canonical);
      expect(Date.parse(seen.expires_at)).toBeGreaterThan(0);

      // After: both halves of the lease are gone — the broker row AND the seat's file.
      expect(leaseRow(canonical)).toBeNull();
      expect(existsSync(leaseFile)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a checkpoint that THROWS after acquiring still releases the lease (the finally)", async () => {
    const repo = makeRepo(true);
    const env = { CLAUDE_PATROL_PORT: String(PORT), CLAUDE_PATROL_SECRET_FILE: SECRET_FILE };
    // An unwritable lease-file path makes writeLeaseFile throw AFTER the broker lease is
    // taken — a real exception on a real path, which is exactly what the `finally` is for.
    const seat = await registerSeat({
      cwd: repo,
      git_root: repo,
      guarded: true,
      lease_file: join(WT_ROOT, "no-such-dir", "lease.json"),
    });
    try {
      const wtPath = sh(["bun", CLI, "worktree", seat, "throws", "--base", "main"], repo, env).out.trim();
      sh(["sh", "-c", `echo work > "${wtPath}/f.txt"`]);
      git(wtPath, "commit", "-qam", "seat work");

      const cp = sh(["bun", CLI, "checkpoint", seat, "--gate", "true"], repo, env);
      expect(cp.code).not.toBe(0); // it threw
      // The lease must NOT survive the crash: a seat left holding one silently refuses to
      // write until the TTL burns down.
      expect(leaseRow(wtPath)).toBeNull();
      expect(await listWorktrees(seat)).toHaveLength(1); // nothing was deregistered
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
