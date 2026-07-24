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
import { mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  worktreeDirSegment,
  worktreeAddArgs,
} from "../src/commands/worktree.ts";
import { checkpointPlan, TRUNK } from "../src/commands/checkpoint.ts";

const PORT = 17902;
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
});

// --- broker route tests ------------------------------------------------------

test("/worktree-add records the association; /worktree-list returns it", async () => {
  const seat = await registerSeat();
  const add = await post("/worktree-add", { id: seat, path: "/repo/.claude/worktrees/feat", branch: "feat", base_commit: "abc123" });
  expect(add.status).toBe(200);
  expect(((await add.json()) as { ok: boolean }).ok).toBe(true);

  const mine = (await listWorktrees(seat)).find((w) => w.seat_id === seat)!;
  expect(mine).toBeDefined();
  expect(mine.path).toBe("/repo/.claude/worktrees/feat");
  expect(mine.branch).toBe("feat");
  expect(mine.base_commit).toBe("abc123");
});

test("/worktree-add upserts on (seat_id, path): re-recording refreshes, never duplicates", async () => {
  const seat = await registerSeat();
  const p = "/repo/.claude/worktrees/dup";
  await post("/worktree-add", { id: seat, path: p, branch: "dup", base_commit: "sha1" });
  await post("/worktree-add", { id: seat, path: p, branch: "dup", base_commit: "sha2" });
  const rows = (await listWorktrees(seat)).filter((w) => w.path === p);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.base_commit).toBe("sha2"); // refreshed
});

test("/worktree-list by id returns only that seat's; omitted returns all", async () => {
  const a = await registerSeat();
  const b = await registerSeat();
  await post("/worktree-add", { id: a, path: "/wt/a", branch: "a", base_commit: "x" });
  await post("/worktree-add", { id: b, path: "/wt/b", branch: "b", base_commit: "y" });

  const onlyA = await listWorktrees(a);
  expect(onlyA.every((w) => w.seat_id === a)).toBe(true);
  expect(onlyA.some((w) => w.path === "/wt/a")).toBe(true);
  expect(onlyA.some((w) => w.path === "/wt/b")).toBe(false);

  const all = await listWorktrees();
  expect(all.some((w) => w.seat_id === a && w.path === "/wt/a")).toBe(true);
  expect(all.some((w) => w.seat_id === b && w.path === "/wt/b")).toBe(true);
});

test("/worktree-remove drops the association and is idempotent; owner-scoped by seat_id+path", async () => {
  const a = await registerSeat();
  const b = await registerSeat();
  const p = "/wt/shared-name";
  await post("/worktree-add", { id: a, path: p, branch: "a", base_commit: "x" });
  await post("/worktree-add", { id: b, path: p, branch: "b", base_commit: "y" });

  // b removing "its" (seat_id=b, path=p) must NOT drop a's row at the same path.
  expect(((await (await post("/worktree-remove", { id: b, path: p })).json()) as { ok: boolean }).ok).toBe(true);
  expect((await listWorktrees(a)).some((w) => w.path === p)).toBe(true); // a survives
  expect((await listWorktrees(b)).some((w) => w.path === p)).toBe(false);

  // a removes its own — gone; removing again is a clean no-op.
  expect(((await (await post("/worktree-remove", { id: a, path: p })).json()) as { ok: boolean }).ok).toBe(true);
  expect(((await (await post("/worktree-remove", { id: a, path: p })).json()) as { ok: boolean }).ok).toBe(true);
  expect((await listWorktrees(a)).some((w) => w.path === p)).toBe(false);
});

test("endSeat drops a seat's worktree ASSOCIATIONS (git tree never touched)", async () => {
  // Register LIVE, record two worktrees, then /unregister → endSeat reaps the rows.
  const reg = await post("/register", { pid: alivePid(), cwd: "/tmp/wt-dead", git_root: null, tty: null, summary: "dying", role: "ghost", model: null });
  const dead = ((await reg.json()) as { id: string }).id;
  await post("/worktree-add", { id: dead, path: "/wt/dead-1", branch: "d1", base_commit: "x" });
  await post("/worktree-add", { id: dead, path: "/wt/dead-2", branch: "d2", base_commit: "y" });
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

describe("checkpointPlan (pure — the dangerous merge-back path, asserted without running git)", () => {
  const plan = checkpointPlan({ repo: "/repo", intPath: "/tmp/int/trunk", seatPath: "/repo/.claude/worktrees/feat", branch: "feat" });

  test("the integration worktree checks out the trunk as a BRANCH (not --detach)", () => {
    // Checking out `main` as a branch is what lets the merge itself advance
    // refs/heads/main; --detach would merge a detached head and leave main behind.
    expect(plan.integrationAdd).toEqual(["-C", "/repo", "worktree", "add", "/tmp/int/trunk", TRUNK]);
    expect(plan.integrationAdd).not.toContain("--detach");
  });

  test("the merge + abort run ONLY inside the integration worktree, never the primary or the seat tree", () => {
    expect(plan.merge).toEqual(["-C", "/tmp/int/trunk", "merge", "--no-edit", "feat"]);
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
    const seat = await registerSeat({ cwd: repo, git_root: repo, handle: "e2e-builder" });
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

    const seat = await registerSeat({ cwd: repo, git_root: repo, handle: "e2e-conflict" });
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
    const seat = await registerSeat({ cwd: repo, git_root: repo, handle: "e2e-guard" });
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
});
