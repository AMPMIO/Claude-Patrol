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
// v0.2.9 — MUTUAL EXCLUSION replaces fence-and-detect. Three adversarial reviews each found
// a way this reported success while a commit went unmerged, and the third proved the last
// fence cannot even read the seat's HEAD (the worktree is already gone by then). Detection
// cannot win a race against a still-working agent, so the seat is QUIESCED first: acquire a
// lease, write the lease FILE the seat's PreToolUse guard hook stats (it denies the seat's
// tool calls while that file is live), verify the branch tip has stopped moving, and only
// THEN merge. FENCES 1/2/3 are kept exactly as they were — they are now the detector for
// what a lease CANNOT cover, not the primary defense.
//
// WHAT THE LEASE IS AND IS NOT (v0.2.9.1 — say this plainly, it was overclaimed before).
// The lease quiesces the seat's TOOL CALLS. It is not a freeze of the worktree:
//   * a background process the seat spawned BEFORE the lease landed keeps writing, and no
//     PreToolUse hook can see it (process-level quiescence is deliberately out of scope);
//   * a tool call already in flight completes (QUIESCE_SETTLE_MS covers that one);
//   * `guarded` proves the hook is INSTALLABLE, never that Claude loaded it (see
//     checkGuardable in seat-server.ts).
// So this is the strongest thing a hook-based mechanism can be, and the fences stay.
//
// v0.2.9.1 also fixes the lease outliving nothing: the lease is RENEWED on a timer for the
// whole run (LEASE_RENEW_MS), because a `--gate` or a large-repo merge easily outlives the
// 120s TTL — past which the hook fails open and the seat silently resumes writing while
// this process merges on. A renewal failure ABORTS; nothing proceeds on a lapsed lease.
//
// The lease is ALWAYS released in a `finally`, on every exit path including an exception. A
// leaked lease outliving its TTL is survivable (the hook fails open on expiry) but must not
// be the normal case — that is a seat that mysteriously cannot write for two minutes.
import { spawnSync, spawn, type Subprocess } from "bun";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { brokerPost, BrokerError, resolveSeatTarget, gitRoot } from "./_client.ts";
import { LEASE_FILE_ENV, LEASE_TTL_SECONDS } from "../../shared/types.ts";
import type { Worktree, Seat, LeaseWorktreeResponse } from "../../shared/types.ts";

// A worktree row plus the lease column /worktree-list now joins in (v0.2.9, additive).
type LeasedWorktree = Worktree & { lease_expires_at?: string | null };

// How long to wait between the two tip reads that prove the seat has gone quiet. A write
// already IN FLIGHT when the lease landed still completes — the hook denies the next tool
// call, not the one already running — so the tip can move once AFTER acquisition. Two equal
// reads either side of this pause is the evidence that it has stopped.
const QUIESCE_SETTLE_MS = 300;

// v0.2.9.1 — HOW OFTEN THE LEASE IS RENEWED, and why this exists at all.
//
// Through v0.2.9 the lease file was written ONCE and then a `--gate` ran to completion
// synchronously. LEASE_TTL_SECONDS is 120 and the guard hook FAILS OPEN past expiry, so
// any gate longer than two minutes — an ordinary test suite — silently un-quiesced the
// seat MID-CHECKPOINT while checkpoint carried on to merge and remove. That is exactly
// the race the lease exists to remove, restored by the lease's own timeout.
//
// So the lease is renewed on a timer at a THIRD of the TTL: two consecutive renewals can
// fail and the seat is still quiesced when the third is attempted. A renewal that DOES
// fail is fatal — see the abort path in checkpoint(); nothing proceeds on a lapsed lease.
// The env override exists so the renewal can be exercised without a 120-second test (same
// idiom as the broker's CLAUDE_PATROL_LEASE_TTL_MS). It changes the CADENCE only — never
// the TTL the hook enforces — so a bad value can make renewals more frequent, never later.
const LEASE_RENEW_MS = Math.min(
  (LEASE_TTL_SECONDS * 1000) / 3,
  parseInt(process.env.CLAUDE_PATROL_CHECKPOINT_RENEW_MS ?? "") || (LEASE_TTL_SECONDS * 1000) / 3
);

// Is `child` the same directory as `parent`, or nested under it? Deliberately a COPY of
// the same helper in plugin/hooks/checkpoint-guard.ts: that hook is self-contained so it
// survives packaging, and the two must agree on what "the lease covers this session"
// means. A drift makes checkpoint accept a seat whose hook will never deny.
function within(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

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

export function parse(args: string[]): { positionals: string[]; gate: string | null; force: boolean } {
  const positionals: string[] = [];
  let gate: string | null = null;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--gate") {
      gate = args[++i] ?? null;
    } else if (args[i] === "--force") {
      force = true;
    } else {
      positionals.push(args[i]!);
    }
  }
  return { positionals, gate, force };
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

// The seat's half of the lease: the guard hook's fast path is a FILE stat, not a broker
// round-trip (PreToolUse fires on every tool call — a request per call would tax the fleet).
// Contents are what the hook needs to decide: when this lease dies, which tree it covers,
// and (v0.2.9.1) the per-checkpoint token that says WHOSE lease this is.
//
// mkdir is defensive, not decorative: `patrol up` creates the lease dir at launch, but a
// seat installed by hand (or a clean install whose fleet was never `patrol up`ed) has no
// such directory, and this used to throw ENOENT AFTER the broker lease was taken — a seat
// recorded as quiesced with nothing on disk actually guarding it.
// `version` is what lets this format change later without a stale hook misreading a new
// file: an old hook that doesn't recognize the version FAILS OPEN rather than guessing at
// fields that have moved. Bump it on any change to the meaning of the fields below.
const LEASE_FILE_VERSION = 1;

function writeLeaseFile(leaseFile: string, expiresAt: string, path: string, token: string) {
  mkdirSync(dirname(leaseFile), { recursive: true, mode: 0o700 });
  writeFileSync(leaseFile, JSON.stringify({ version: LEASE_FILE_VERSION, token, expires_at: expiresAt, path }));
}

// Unlink the lease file ONLY if it is still ours. Through v0.2.9 release unlinked
// unconditionally, so a second checkpoint on the same seat (which the broker also let
// through — leases were keyed on seat_id alone) could delete the file the first one was
// still running behind, un-quiescing the seat mid-merge. Reading the token back before
// unlinking is the check that makes release owner-scoped on the filesystem too.
function unlinkOwnLeaseFile(leaseFile: string, token: string) {
  try {
    const on_disk = JSON.parse(readFileSync(leaseFile, "utf8"))?.token;
    if (on_disk !== token) return; // someone else's lease (or a stale file) — leave it alone
    unlinkSync(leaseFile);
  } catch {
    /* never written, already gone, or unreadable — nothing safe to remove */
  }
}

// Best-effort by design: this runs from a `finally` where the interesting failure has
// already happened and must not be masked by a cleanup throw. An unremoved file still
// expires (the hook fails open past expires_at), so the worst case is bounded.
//
// A null token means the acquire never succeeded (the `--force`-without-a-lease path), so
// there is nothing of ours to release and releasing anyway would drop somebody else's.
function releaseLease(id: string, path: string, leaseFile: string | null, token: string | null) {
  if (token === null) return Promise.resolve();
  if (leaseFile) unlinkOwnLeaseFile(leaseFile, token);
  return brokerPost<{ ok: true }>("/release-worktree", { id, path, token }).catch(() => {});
}

export default async function checkpoint(args: string[]): Promise<number> {
  const { positionals, gate, force } = parse(args);
  const [target] = positionals;
  if (!target) {
    console.error('usage: patrol checkpoint <handle-or-id> [--gate "<cmd>"] [--force]');
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
    branch = wts[0]!.branch;
    // Canonicalize before anything compares paths: the broker stores associations under the
    // realpath, and every later check (multi-owner, lease, release) must speak that name.
    try {
      seatPath = realpathSync(wts[0]!.path);
    } catch {
      console.error(`patrol checkpoint: the tracked worktree ${wts[0]!.path} no longer exists on disk`);
      console.error(`  branch ${branch} still holds the work; re-create a worktree on it, or merge it by hand.`);
      return 1;
    }

    // A db written before v0.2.9 canonicalization can hold SEVERAL rows for one tree under
    // different spellings — i.e. two seats in one worktree. Merging then removes the tree out
    // from under the other seat. Those rows are deliberately never auto-migrated (a UNIQUE
    // index would fail at startup for exactly the affected users), so STOP for a human.
    const owners = new Set(
      (await brokerPost<LeasedWorktree[]>("/worktree-list", {}))
        .filter((w) => {
          try {
            return realpathSync(w.path) === seatPath;
          } catch {
            return w.path === seatPath; // tree gone: fall back to the stored spelling
          }
        })
        .map((w) => w.seat_id)
    );
    if (owners.size > 1) {
      console.error(`patrol checkpoint: ${seatPath} is tracked by ${owners.size} seats (${[...owners].join(", ")}) — refusing to check in a tree two seats share.`);
      console.error(`  this is a legacy duplicate association. Resolve it first: 'patrol worktree' the wrong seat off the path, then re-run.`);
      return 1;
    }

    // The guard requirement. An UNGUARDED seat has no PreToolUse hook to deny its writes, so
    // no lease can quiesce it and every fence below degrades to the racy detection this
    // release exists to replace. Refuse rather than report a success we cannot stand behind.
    const seats = await brokerPost<Seat[]>("/list-seats", { scope: "machine", cwd: process.cwd(), git_root: repo });
    const seat = seats.find((s) => s.id === id) ?? null;
    const leaseFilePath = seat?.lease_file ?? null;
    if (!force) {
      if (!seat?.guarded) {
        console.error(`patrol checkpoint: ${target} is not a guarded seat — it cannot be quiesced, so a checkpoint could merge a stale tip while it keeps committing.`);
        console.error(`  stop the seat and re-run, or pass --force to accept the old best-effort (fences-only) behavior.`);
        return 1;
      }
      // Guarded but the broker has no lease-file path: the hook exists and would honor a
      // lease, but nothing can create the file it watches. That is an unquiesced seat wearing
      // a guarded label — the one case where proceeding silently would be worst.
      if (!leaseFilePath) {
        console.error(`patrol checkpoint: ${target} reports guarded but the broker has no lease-file path for it, so its guard hook can never see this lease.`);
        console.error(`  relaunch the seat so it registers its ${LEASE_FILE_ENV} path, or pass --force to accept fences-only behavior.`);
        return 1;
      }
      // CWD BINDING. v0.2.9.1 binds the guard hook's deny to the worktree the lease
      // names, so a stale or foreign lease file cannot freeze an unrelated seat. The cost
      // is that a seat whose session cwd is disjoint from the tree being checkpointed
      // gets NO deny — and because the hook fails open, that would be silent. Refuse here
      // instead: a loud "cannot bind" beats merging behind a guard that never fires.
      const seatCwd = (() => { try { return realpathSync(seat.cwd); } catch { return seat.cwd; } })();
      if (!within(seatCwd, seatPath) && !within(seatPath, seatCwd)) {
        console.error(`patrol checkpoint: ${target} is working in ${seatCwd}, which is outside the worktree being checked in (${seatPath}).`);
        console.error(`  its guard hook binds a lease to the tree the seat is sitting in, so this lease could not deny anything — the seat would keep writing.`);
        console.error(`  check in the worktree the seat actually occupies, or pass --force to accept fences-only behavior.`);
        return 1;
      }
    }

    // ACQUIRE. --force skips only the GUARD requirement above — it must still take the lease
    // when it can, so a forced checkpoint still excludes a second concurrent checkpoint.
    const lease = await brokerPost<LeaseWorktreeResponse>("/lease-worktree", { id, path: seatPath });
    // The per-CHECKPOINT token, minted by the broker at acquire. null == we hold nothing.
    const token = lease.ok ? lease.token! : null;
    if (!lease.ok) {
      console.error(`patrol checkpoint: could not lease ${seatPath} — ${lease.error ?? "unknown"}`);
      if (!force) return 1;
      console.error(`  --force: proceeding WITHOUT the lease; the seat is not quiesced and the fences are the only protection.`);
    }
    // Everything past acquisition releases in the `finally` below — including a throw.
    //
    // RENEWAL. A held lease must outlive whatever runs under it — a gate, a slow merge on
    // a large repo — or it expires, the hook fails open, and the seat resumes writing
    // while checkpoint carries on believing it is quiesced. So renew on a timer for as
    // long as we hold it, and treat a renewal FAILURE as fatal: the abort path below
    // kills the gate and refuses to merge rather than continue on a lapsed lease.
    //
    // `lost` is an object, not a bare `let`: TypeScript keeps the narrowing from the
    // initializer across the closure assignment, so a plain string|null would read as
    // never-set at the checks below.
    const lost: { why: string | null } = { why: null };
    let gateChild: Subprocess | null = null;
    let renewTimer: ReturnType<typeof setInterval> | null = null;
    const renew = async () => {
      try {
        const r = await brokerPost<LeaseWorktreeResponse>("/lease-worktree", { id, path: seatPath, token: token! });
        if (!r.ok) throw new Error(r.error ?? "broker refused the renewal");
        if (leaseFilePath) writeLeaseFile(leaseFilePath, r.expires_at!, seatPath, token!);
      } catch (e) {
        lost.why = e instanceof Error ? e.message : String(e);
        if (renewTimer) clearInterval(renewTimer);
        renewTimer = null;
        // Kill the gate NOW — from here on it is running against an unquiesced seat, and
        // every second it keeps running is a second the seat can commit underneath it.
        // NOTE: this signals the `sh -c` child, not its whole process group, so a gate
        // that backgrounded work of its own can leave grandchildren running.
        gateChild?.kill();
      }
    };
    // Reports the abort and returns true when the lease has lapsed. Called before every
    // step that mutates anything, so a renewal failure can never be overtaken by a merge.
    const leaseLapsed = (): boolean => {
      if (lost.why === null) return false;
      console.error(`patrol checkpoint: ABORTED — the lease on ${seatPath} could not be renewed (${lost.why}).`);
      console.error(`  the seat is no longer quiesced, so nothing was merged and the worktree is left intact and still tracked.`);
      return true;
    };

    // QUIESCED means the seat's guard hook can actually see this lease — a broker row plus
    // the FILE that hook stats. A row on its own excludes other checkpoints and nothing
    // else, so it must never be reported as if the seat had been paused.
    const quiesced = token !== null && leaseFilePath !== null;
    try {
      if (token) {
        if (leaseFilePath) writeLeaseFile(leaseFilePath, lease.expires_at!, seatPath, token);
        renewTimer = setInterval(renew, LEASE_RENEW_MS);
      }

      // VERIFY QUIESCENCE. A tool call already in flight when the lease landed still
      // completes, so the tip may move once more after acquisition. Read it, pause, read
      // again: two equal reads is the evidence the seat has actually stopped. Reading the
      // tip is also what snapshots it — merging a SHA we watched go still is the whole point.
      const readTip = () => git(["-C", seatPath, "rev-parse", branch]);
      const first = readTip();
      if (!first.ok) {
        console.error(`patrol checkpoint: cannot resolve branch ${branch} in ${seatPath} — ${first.stderr.trim() || "rev-parse failed"}`);
        return 1;
      }
      await new Promise((r) => setTimeout(r, QUIESCE_SETTLE_MS));
      const second = readTip();
      const branchSha = second.stdout.trim();
      if (!second.ok || branchSha !== first.stdout.trim()) {
        console.error(`patrol checkpoint: ${target} is still writing — branch ${branch} moved ${first.stdout.trim().slice(0, 12)} → ${branchSha.slice(0, 12)} after the lease was taken.`);
        console.error(`  nothing was merged; the worktree at ${seatPath} is left intact. Re-run once the seat is idle.`);
        return 1;
      }
      // Pin HEAD as well as the tip: every later check compares against BOTH, so a seat
      // that `git checkout`s elsewhere and commits there is caught instead of sailing
      // through on an unchanged `branch` ref. "" means the seat was already detached.
      const headAtSnapshot = symbolicHead(seatPath);

      // 1. Gate — run IN THE WORKTREE. A failing gate must never reach the merge.
      //
      // ASYNCHRONOUS as of v0.2.9.1. spawnSync blocked this whole process, which meant the
      // renewal timer above could never fire: the lease expired under any gate longer than
      // LEASE_TTL_SECONDS (an ordinary test suite), the hook failed open, and the seat went
      // back to writing while checkpoint went on to merge and remove. Awaiting the child
      // instead keeps the event loop — and therefore the renewal — alive for the duration.
      if (gate) {
        gateChild = spawn(["sh", "-c", gate], { cwd: seatPath, stdout: "inherit", stderr: "inherit" });
        const code = await gateChild.exited;
        gateChild = null;
        // Order matters: a lapsed lease is why the gate died, so report THAT, not "gate
        // failed (exit 143)" — which would read as the user's tests failing.
        if (leaseLapsed()) return 1;
        if (code !== 0) {
          console.error(`patrol checkpoint: gate failed (exit ${code}) — not merging; worktree left intact at ${seatPath}`);
          return 1;
        }
      }
      if (leaseLapsed()) return 1;

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

        // Last check before the only irreversible step. `git worktree add` can be slow on
        // a large repo, so the lease may have lapsed since the fence above.
        if (leaseLapsed()) return 1;

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

        // The merge has landed on TRUNK and cannot be un-done here, but removing the
        // seat's tree still can be withheld: on a lapsed lease, stop and keep the tree.
        if (lost.why !== null) {
          console.error(`patrol checkpoint: INCOMPLETE — merged ${head.slice(0, 12)} into ${TRUNK}, but the lease lapsed (${lost.why}) before the worktree could be removed.`);
          console.error(`  ${TRUNK} KEEPS the merge — an abort stops and reports state, it never unwinds an integration that already landed.`);
          console.error(`  the worktree at ${seatPath} is left intact and still tracked; nothing is lost. Re-run once the seat is idle to finish the removal.`);
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

        // Say exactly what was and was not guaranteed — three genuinely different states,
        // because a broker lease alone quiesces NOTHING. Holding the row without a lease
        // FILE (a --force'd unguarded seat) only excluded a competing checkpoint; the seat
        // itself kept its hands free the whole time. And even a full lease pauses the
        // seat's TOOL CALLS, not a process it had already spawned. Overclaiming here is
        // what would make the next reader trust this more than they should.
        console.log(`checkpoint: merged ${branch} into ${TRUNK} → ${head}`);
        console.log(
          quiesced
            ? `  (lease held throughout; the seat's tool calls were paused — background processes it had already started are not covered)`
            : token
              ? `  (--force: ran WITHOUT a lease on the seat — it was NOT paused; the lease only kept other checkpoints out, and the fences alone checked for drift)`
              : `  (--force: ran WITHOUT a lease at all — the seat was NOT paused and only the fences checked for drift)`
        );
        console.log(`removed worktree ${seatPath} (branch ${branch} left in place)`);
        return 0;
      } finally {
        // Always drop the throwaway integration tree (best-effort — on an add failure it
        // never existed) and its temp parent. Removing it leaves the trunk advanced.
        git(plan.integrationRemove);
        rmSync(intParent, { recursive: true, force: true });
      }
    } finally {
      // RELEASE on EVERY exit path — success, refusal, and exception alike. A seat left
      // holding a lease it cannot see the end of is one that silently refuses to work until
      // the TTL expires, which is the failure that would make this feature worse than the
      // fences it replaces. Stop renewing FIRST, or the timer keeps the process alive and
      // can re-create the very file the release just removed.
      if (renewTimer) clearInterval(renewTimer);
      gateChild?.kill();
      await releaseLease(id, seatPath, leaseFilePath, token);
    }
  } catch (e) {
    console.error(e instanceof BrokerError ? e.message : String(e));
    return 1;
  }
}
