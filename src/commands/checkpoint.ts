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

    // 1. Gate — run IN THE WORKTREE. A failing gate must never reach the merge.
    if (gate) {
      const g = spawnSync(["sh", "-c", gate], { cwd: seatPath, stdout: "inherit", stderr: "inherit" });
      if ((g.exitCode ?? 1) !== 0) {
        console.error(`patrol checkpoint: gate failed (exit ${g.exitCode}) — not merging; worktree left intact at ${seatPath}`);
        return 1;
      }
    }

    // The seat may have committed during the gate. If the branch moved off the snapshot,
    // STOP before merging a stale tip — nothing was integrated, so re-running picks up
    // the new work cleanly.
    const afterGate = git(["-C", seatPath, "rev-parse", branch]).stdout.trim();
    if (afterGate !== branchSha) {
      console.error(
        `patrol checkpoint: ${target} advanced during checkpoint — branch ${branch} moved ${branchSha.slice(0, 12)} → ${afterGate.slice(0, 12)} after the gate; nothing was merged. Re-run to integrate the new work.`
      );
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

      // 3. Merge landed on the pinned snapshot. Before dropping the tree, re-check the
      // branch: a standing seat could have committed DURING the merge. If it moved past
      // the snapshot, main now holds exactly the snapshot (correct — not advanced past
      // it), but newer work remains on the branch. STOP without removing the worktree or
      // deregistering, so we never report a false success that strands that work.
      const beforeRemove = git(["-C", seatPath, "rev-parse", branch]).stdout.trim();
      if (beforeRemove !== branchSha) {
        console.error(
          `patrol checkpoint: ${target} advanced during checkpoint — branch ${branch} moved ${branchSha.slice(0, 12)} → ${beforeRemove.slice(0, 12)}; merged ${head.slice(0, 12)} into ${TRUNK} but newer work remains on ${branch}. Re-run to integrate it.`
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
