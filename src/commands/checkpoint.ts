// patrol checkpoint <seat> [--gate "<cmd>"] — the merge-back. Integrate a seat's
// task branch into the trunk, then remove + de-register its worktree. The branch is
// left in place (deleting a branch is destructive and out of scope).
//
// SAFETY — the load-bearing rule: NEVER mutate a working tree we don't own (a seat
// may be mid-build in the primary checkout). The merge therefore runs in a THROWAWAY
// integration worktree that checks out the trunk as a BRANCH: the merge itself
// advances refs/heads/<trunk>, and git's one-branch-one-worktree invariant REFUSES
// the `worktree add` when a live checkout already holds the trunk — that refusal is
// our concurrency interlock (we never move a ref another live worktree has checked
// out; doing so would desync that tree's index/HEAD). We deliberately check out the
// trunk as a branch rather than `--detach`: a detached integration head would merge
// without advancing the trunk ref, forcing an unsafe `update-ref` into a live tree.
// No `git checkout`/`git merge`/`git reset` is ever run against the primary checkout.
//
// RESIDUAL RACE (not closable in this file). The seat is a standing process nobody can
// pause from here, so checkpoint is fence-and-detect, not mutual exclusion: FENCE 1/2/3
// below narrow the window to "between FENCE 3's rev-parse and the print", and every
// fence that trips reports INCOMPLETE with the branch intact instead of a false success.
// A commit landing inside that last sliver — only reachable by writing refs/heads/<branch>
// from outside the (now removed) seat tree — would still be missed by the success line;
// the branch keeps it, so nothing is lost, but the report would be wrong. Closing it for
// real needs the seat QUIESCED across the whole sequence, i.e. a broker/protocol change
// (a checkpoint lease the seat honors) that is out of scope for the CLI.
import { spawnSync } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerPost, BrokerError, resolveSeatTarget, gitRoot } from "./_client.ts";
import type { Worktree } from "../../shared/types.ts";

// The integration target. The v0.2.6 contract and the fleet discipline integrate
// task branches into "main"; a fleet on a different trunk would parameterize this.
export const TRUNK = "main";

// The exact git argv sequence the merge-back runs, as pure data (no git is touched
// here — unit-tested so the dangerous path is asserted without running it live).
// Every argv omits the leading "git"; the runner prepends it. `-C <dir>` makes the
// target tree explicit and auditable: the merge only ever runs `-C <intPath>` (the
// isolated worktree), never against the repo root or the seat's tree.
export interface CheckpointPlan {
  integrationAdd: string[]; // worktree add <intPath> <trunk>   — in the repo; checks out trunk as a BRANCH
  merge: string[]; //          -C <intPath> merge --no-edit <mergeRef> — ff when it can, else a merge commit
  mergeAbort: string[]; //     -C <intPath> merge --abort         — conflict cleanup (trunk ref untouched on conflict)
  resolveHead: string[]; //    -C <intPath> rev-parse HEAD        — the resulting trunk commit
  integrationRemove: string[]; // worktree remove --force <intPath> — drop the throwaway tree
  seatRemove: string[]; //     worktree remove <seatPath>         — drop the seat's task tree (fails if dirty: no forced loss)
}

// mergeRef is the EXACT commit SHA snapshotted before the gate, not the branch name:
// a standing seat can commit between the gate and worktree-removal, and merging by name
// would silently integrate (or race) whatever the branch points at NOW. Merging the
// pinned SHA is what makes the post-merge "did the branch move?" check meaningful.
export function checkpointPlan(opts: { repo: string; intPath: string; seatPath: string; mergeRef: string; trunk?: string }): CheckpointPlan {
  const trunk = opts.trunk ?? TRUNK;
  const inRepo = ["-C", opts.repo];
  const inInt = ["-C", opts.intPath];
  return {
    integrationAdd: [...inRepo, "worktree", "add", opts.intPath, trunk],
    merge: [...inInt, "merge", "--no-edit", opts.mergeRef],
    mergeAbort: [...inInt, "merge", "--abort"],
    resolveHead: [...inInt, "rev-parse", "HEAD"],
    integrationRemove: [...inRepo, "worktree", "remove", "--force", opts.intPath],
    seatRemove: [...inRepo, "worktree", "remove", opts.seatPath],
  };
}

function parse(args: string[]): { positionals: string[]; gate: string | null } {
  const positionals: string[] = [];
  let gate: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--gate") {
      gate = args[++i] ?? null;
    } else {
      positionals.push(args[i]!);
    }
  }
  return { positionals, gate };
}

function git(argv: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(["git", ...argv]);
  return { ok: r.exitCode === 0, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "" };
}

// The branch a worktree's HEAD points at, or "" when detached (`--quiet` makes a
// detached HEAD exit non-zero with no output rather than an error).
function symbolicHead(seatPath: string): string {
  return git(["-C", seatPath, "symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
}

// One fence point: has the standing seat moved off the pinned snapshot? Checks HEAD
// FIRST — binding only to the recorded branch name misses a seat that switches branches
// and commits there, which leaves `branch` untouched so every SHA check would pass while
// the new work sits on a ref we never merge. Returns a drift description to STOP on, or
// null when the seat is exactly where it was pinned.
function seatDrift(seatPath: string, branch: string, branchSha: string, headAtSnapshot: string): string | null {
  const head = symbolicHead(seatPath);
  if (head !== headAtSnapshot) {
    return `switched branches during checkpoint — HEAD in ${seatPath} moved ${headAtSnapshot || "(detached)"} → ${head || "(detached)"}`;
  }
  const tip = git(["-C", seatPath, "rev-parse", branch]).stdout.trim();
  if (tip !== branchSha) {
    return `advanced during checkpoint — branch ${branch} moved ${branchSha.slice(0, 12)} → ${tip.slice(0, 12)}`;
  }
  return null;
}

export default async function checkpoint(args: string[]): Promise<number> {
  const { positionals, gate } = parse(args);
  const [target] = positionals;
  if (!target) {
    console.error('usage: patrol checkpoint <handle-or-id> [--gate "<cmd>"]');
    return 2;
  }

  const repo = gitRoot(process.cwd());
  if (!repo) {
    console.error("patrol checkpoint: not in a git repo (run from inside the seat's repo)");
    return 1;
  }

  let seatPath: string;
  let branch: string;
  try {
    const id = await resolveSeatTarget(target);
    const wts = await brokerPost<Worktree[]>("/worktree-list", { id });
    if (wts.length === 0) {
      console.error(`patrol checkpoint: ${target} has no tracked worktree — nothing to check in`);
      return 1;
    }
    if (wts.length > 1) {
      console.error(
        `patrol checkpoint: ${target} tracks ${wts.length} worktrees; check in one at a time (branches: ${wts.map((w) => w.branch).join(", ")})`
      );
      return 1;
    }
    seatPath = wts[0]!.path;
    branch = wts[0]!.branch;

    // Snapshot the branch tip BEFORE anything else. The seat is a STANDING process: it
    // can commit between here and worktree-removal. We merge THIS exact commit and
    // refuse to remove/deregister if the branch later moved past it — otherwise a
    // commit landing after the merge would leave a clean tree, so remove + deregister
    // "succeed" while main lacks that commit: a false success. rev-parse from the seat's
    // tree resolves refs/heads/<branch> (linked worktrees share refs).
    const snap = git(["-C", seatPath, "rev-parse", branch]);
    if (!snap.ok) {
      console.error(`patrol checkpoint: cannot resolve branch ${branch} in ${seatPath} — ${snap.stderr.trim() || "rev-parse failed"}`);
      return 1;
    }
    const branchSha = snap.stdout.trim();
    // Pin HEAD as well as the tip: every later check compares against BOTH, so a seat
    // that `git checkout`s elsewhere and commits there is caught instead of sailing
    // through on an unchanged `branch` ref. "" means the seat was already detached.
    const headAtSnapshot = symbolicHead(seatPath);

    // 1. Gate — run IN THE WORKTREE. A failing gate must never reach the merge.
    if (gate) {
      const g = spawnSync(["sh", "-c", gate], { cwd: seatPath, stdout: "inherit", stderr: "inherit" });
      if ((g.exitCode ?? 1) !== 0) {
        console.error(`patrol checkpoint: gate failed (exit ${g.exitCode}) — not merging; worktree left intact at ${seatPath}`);
        return 1;
      }
    }

    // FENCE 1 (post-gate, pre-merge). The seat may have committed or switched branches
    // during the gate. STOP before merging a stale tip — nothing was integrated, so
    // re-running picks up the new work cleanly.
    const gateDrift = seatDrift(seatPath, branch, branchSha, headAtSnapshot);
    if (gateDrift) {
      console.error(`patrol checkpoint: ${target} ${gateDrift} (after the gate); nothing was merged. Re-run to integrate the new work.`);
      console.error(`  the worktree at ${seatPath} is left intact and still tracked.`);
      return 1;
    }

    // 2. Safe merge in a throwaway integration worktree. `intPath` must NOT exist for
    // `git worktree add` to create it, so use a child of a fresh temp dir.
    const intParent = mkdtempSync(join(tmpdir(), "patrol-checkpoint-"));
    const intPath = join(intParent, "trunk");
    const plan = checkpointPlan({ repo, intPath, seatPath, mergeRef: branchSha });
    try {
      const add = git(plan.integrationAdd);
      if (!add.ok) {
        // Overwhelmingly: the trunk is checked out in a live worktree, so advancing it
        // safely is impossible (see the safety block). STOP — no tree is mutated.
        console.error(`patrol checkpoint: cannot start a safe integration — ${add.stderr.trim() || "git worktree add failed"}`);
        console.error(
          `  the trunk '${TRUNK}' must not be checked out in a live worktree for checkpoint to advance it safely; the seat's worktree is left intact at ${seatPath}`
        );
        return 1;
      }

      const merge = git(plan.merge);
      if (!merge.ok) {
        // Conflict (or an unmet merge precondition, e.g. missing committer identity):
        // the trunk ref was NOT advanced. Abort to clean the throwaway tree, STOP, and
        // leave the seat's worktree untouched so no work is lost. Never auto-resolve.
        git(plan.mergeAbort);
        console.error(`patrol checkpoint: merge of ${branch} into ${TRUNK} failed — ${merge.stderr.trim() || "conflict"}`);
        console.error(`  nothing was integrated; the seat's worktree is left intact at ${seatPath}`);
        return 1;
      }

      const head = git(plan.resolveHead).stdout.trim();

      // FENCE 2 (post-merge, pre-remove). Merge landed on the pinned snapshot. A standing
      // seat could have committed DURING the merge. If it moved, main now holds exactly
      // the snapshot (correct — not advanced past it), but newer work remains on the
      // branch. STOP without removing the worktree or deregistering, so we never report a
      // false success that strands that work.
      const mergeDrift = seatDrift(seatPath, branch, branchSha, headAtSnapshot);
      if (mergeDrift) {
        console.error(
          `patrol checkpoint: ${target} ${mergeDrift}; merged ${head.slice(0, 12)} into ${TRUNK}, but the seat is no longer on the pinned snapshot. Re-run to integrate the newer work.`
        );
        console.error(`  the worktree at ${seatPath} is left intact and still tracked.`);
        return 1;
      }

      // Remove the seat's task tree (plain remove — it fails on uncommitted changes
      // rather than forcibly destroying unmerged work).
      const rm = git(plan.seatRemove);
      if (!rm.ok) {
        console.error(
          `patrol checkpoint: merged ${branch} into ${TRUNK} (${head.slice(0, 12)}), but could not remove the worktree at ${seatPath} — ${rm.stderr.trim()}`
        );
        console.error(`  the association is kept (the tree still exists); resolve it and re-run, or remove the tree by hand`);
        return 1;
      }

      // FENCE 3 (post-remove, pre-deregister) — the last window. A commit landing between
      // FENCE 2 and the removal leaves a CLEAN (committed) tree, so `worktree remove`
      // succeeds and, without this check, we would deregister and print success while
      // TRUNK holds only the pinned snapshot: the new commit is stranded. Re-resolve from
      // the REPO, not the seat path — the seat's tree is gone, but linked worktrees share
      // refs, so refs/heads/<branch> is still readable and still holds that work.
      const afterRemove = git(["-C", repo, "rev-parse", branch]).stdout.trim();
      if (afterRemove !== branchSha) {
        console.error(
          `patrol checkpoint: INCOMPLETE — ${target} advanced during worktree removal; branch ${branch} moved ${branchSha.slice(0, 12)} → ${afterRemove.slice(0, 12)}.`
        );
        console.error(`  merged ${head.slice(0, 12)} into ${TRUNK}; the worktree at ${seatPath} was removed but was NOT deregistered.`);
        console.error(
          `  NOTHING IS LOST: the tree is gone, but branch ${branch} still points at ${afterRemove.slice(0, 12)} and holds the newer work. Re-create a worktree on ${branch} and re-run checkpoint, or merge ${branch} into ${TRUNK} by hand.`
        );
        return 1;
      }

      // De-register only AFTER the tree is gone, so the record and the filesystem
      // never disagree.
      await brokerPost<{ ok: boolean }>("/worktree-remove", { id, path: seatPath });

      console.log(`checkpoint: merged ${branch} into ${TRUNK} → ${head}`);
      console.log(`removed worktree ${seatPath} (branch ${branch} left in place)`);
      return 0;
    } finally {
      // Always drop the throwaway integration tree (best-effort — on an add failure it
      // never existed) and its temp parent. Removing it leaves the trunk advanced.
      git(plan.integrationRemove);
      rmSync(intParent, { recursive: true, force: true });
    }
  } catch (e) {
    console.error(e instanceof BrokerError ? e.message : String(e));
    return 1;
  }
}
