// patrol worktree <seat> <branch> [--base <ref>] — create a task worktree for a
// standing seat and record the seat→worktree association. The seat's session cwd
// never changes; it works in the printed path via cd / absolute paths. git owns the
// tree (this shells out to `git worktree add`); the broker only tracks the
// association (see shared/types.ts Worktree). Idempotent recording, real git tree.
import { spawnSync } from "bun";
import { join } from "node:path";
import { brokerPost, BrokerError, resolveSeatTarget, gitRoot } from "./_client.ts";
import type { WorktreeAddRequest } from "../../shared/types.ts";

// The fleet convention (init-core.ts implementer discipline): task worktrees live
// under <repo>/.claude/worktrees/<branch-segment>.
const WORKTREES_SUBDIR = ".claude/worktrees";

// A branch name folded into ONE safe path segment: any run of chars outside
// [A-Za-z0-9._-] (slashes, spaces, …) collapses to a single '-', trimmed of edge
// dashes. "feat/foo bar" -> "feat-foo-bar". Empty result falls back to "wt" so the
// path is always a valid segment. Pure.
export function worktreeDirSegment(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "wt";
}

// Pure: the exact `git worktree add` argv (WITHOUT the leading "git"; the runner
// prepends ["git", "-C", <repo>]). `-b <branch>` creates the branch; <base> is the
// ref/sha it branches from. Unit-tested; no git is run here.
export function worktreeAddArgs(path: string, branch: string, base: string): string[] {
  return ["worktree", "add", "-b", branch, path, base];
}

// Split positionals from the one recognized flag (--base <ref>).
function parse(args: string[]): { positionals: string[]; base: string | null } {
  const positionals: string[] = [];
  let base: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base") {
      base = args[++i] ?? null;
    } else {
      positionals.push(args[i]!);
    }
  }
  return { positionals, base };
}

function git(repo: string, argv: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(["git", "-C", repo, ...argv]);
  return { ok: r.exitCode === 0, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "" };
}

export default async function worktree(args: string[]): Promise<number> {
  const { positionals, base } = parse(args);
  const [target, branch] = positionals;
  if (!target || !branch) {
    console.error("usage: patrol worktree <handle-or-id> <branch> [--base <ref>]");
    return 2;
  }

  const repo = gitRoot(process.cwd());
  if (!repo) {
    console.error("patrol worktree: not in a git repo (run from inside the seat's repo)");
    return 1;
  }

  try {
    const id = await resolveSeatTarget(target);

    // Resolve the base to a concrete SHA FIRST — it both validates the ref (a clear
    // error before any tree is created) and gives base_commit for the association
    // (recorded for audit + a clean checkpoint).
    const baseRef = base ?? "HEAD";
    const rev = git(repo, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
    if (!rev.ok) {
      console.error(`patrol worktree: bad base ref "${baseRef}" — ${rev.stderr.trim() || "not a commit"}`);
      return 1;
    }
    const baseSha = rev.stdout.trim();

    const path = join(repo, WORKTREES_SUBDIR, worktreeDirSegment(branch));
    const add = git(repo, worktreeAddArgs(path, branch, baseRef));
    if (!add.ok) {
      // git's own message is clear: "a branch named 'X' already exists" /
      // "'<path>' already exists" / "is not a valid ref". Surface it verbatim.
      console.error(`patrol worktree: ${add.stderr.trim() || "git worktree add failed"}`);
      return 1;
    }

    // Record the association. On a broker failure AFTER the tree exists, leave the
    // tree (work is never destroyed by a bookkeeping miss) and report — a re-run of
    // this command upserts the record without recreating the tree.
    const body: WorktreeAddRequest = { id, path, branch, base_commit: baseSha };
    const res = await brokerPost<{ ok: boolean; error?: string }>("/worktree-add", body);
    if (!res.ok) {
      console.error(`patrol worktree: created ${path} but recording it failed — ${res.error ?? "unknown"}`);
      return 1;
    }

    // Tell the standing seat where its task tree is (its session cwd never moves, so
    // it needs the absolute path to `cd` into). Best-effort: the tree + record are
    // the deliverable; a failed nudge must not fail the command.
    await brokerPost<{ ok: boolean }>("/send-message", {
      from_id: "cli",
      to_id: id,
      text: `task worktree ready — cd ${path} (branch ${branch}, from ${baseSha.slice(0, 12)})`,
    }).catch(() => {});

    console.log(path);
    return 0;
  } catch (e) {
    console.error(e instanceof BrokerError ? e.message : String(e));
    return 1;
  }
}
