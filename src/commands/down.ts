// `patrol down [fleet] [--all] [--force]` — tear down what `patrol up` started:
// kill a fleet's tmux session and stop its bg seats. Seats deregister from the
// broker via the W1 SessionEnd hook within the broker's grace window; down only
// stops processes.
//
// v0.3: down is FLEET-SCOPED. It used to kill the one global "patrol" session, so
// running it in any project stopped every project's seats mid-task. With no
// argument it now touches only the fleet inferred from cwd (via the same
// resolver `patrol up` used); another fleet must be named; every fleet needs
// --all.

import { readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { selectBgPidsToKill } from "../launcher/compose.ts";
import { killSession, listSessionNames } from "../launcher/tmux.ts";
import { listAgents } from "../launcher/bg.ts";
import { detectFleet } from "../launcher/fleet-detect.ts";
import {
  fleetFromSession, fleetFromStateFileName, fleetStateFileName, selectFleetsToDown, sessionName,
} from "../launcher/fleet.ts";
import type { FleetState } from "./up.ts";

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const PROFILE_DIR = join(CONFIG_DIR, "patrol-profiles");

// Classify a recorded-fallback pid before signalling it. `claude agents` no
// longer lists this agent, so the pid may have been recycled onto an unrelated
// process. `ps -o command=` prints the full argv for a live pid and exits
// nonzero (empty) once the pid is gone — reliable on macOS and Linux.
//   gone   -> agent already exited; nothing to kill
//   claude -> still our seat; safe to signal
//   other  -> recycled onto something else; refuse unless --force
export function bgPidState(pid: number): "claude" | "other" | "gone" {
  const r = spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
  const out = r.stdout?.toString().trim() ?? "";
  if (r.exitCode !== 0 || out === "") return "gone";
  return /claude/i.test(out) ? "claude" : "other";
}

// Every fleet this machine knows about: live tmux sessions plus recorded state
// files (a bg-only fleet has no session, and a leaked session has no state).
function knownFleets(): string[] {
  const fleets = new Set<string>();
  for (const s of listSessionNames()) {
    const f = fleetFromSession(s);
    if (f) fleets.add(f);
  }
  try {
    for (const entry of readdirSync(PROFILE_DIR)) {
      const f = fleetFromStateFileName(entry);
      if (f) fleets.add(f);
    }
  } catch {
    /* no profile dir yet — nothing has ever launched */
  }
  return [...fleets];
}

function downOne(fleet: string, force: boolean): void {
  const statePath = join(PROFILE_DIR, fleetStateFileName(fleet));
  let state: FleetState | null = null;
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      console.error(`patrol down: fleet state for "${fleet}" is corrupt — killing its tmux session best-effort`);
    }
  }

  // tmux: kill this fleet's session if present (even without state, in case it
  // leaked). killSession targets `=patrol-<fleet>`, so no other fleet can match.
  const killed = killSession(fleet);
  if (killed) console.log(`patrol down: killed tmux session "${sessionName(fleet)}"`);

  // bg: stop this fleet's recorded seats. Re-query live agents so we kill the
  // right pids.
  if (state?.bg?.length) {
    const { verified, unverified } = selectBgPidsToKill(state.bg, listAgents());
    let stopped = 0;
    const sigterm = (pid: number) => {
      try {
        process.kill(pid, "SIGTERM");
        stopped++;
      } catch {
        // already gone
      }
    };
    // Verified pids still match a live `claude agents` entry — signal directly.
    for (const pid of verified) sigterm(pid);
    // Unverified pids only survive in fleet state; confirm each still looks like
    // our claude (or --force) before signalling, so a recycled pid is spared.
    for (const pid of unverified) {
      const st = force ? "claude" : bgPidState(pid);
      if (st === "gone") continue; // already exited — nothing to kill
      if (st === "other") {
        console.error(`patrol down: refusing to kill pid ${pid} — its agent is gone and the pid no longer looks like claude (possibly recycled); use --force to override`);
        continue;
      }
      sigterm(pid);
    }
    console.log(`patrol down: stopped ${stopped}/${state.bg.length} bg seat(s) in fleet "${fleet}"`);
  }

  if (existsSync(statePath)) rmSync(statePath);
  if (!killed && !state?.bg?.length) {
    console.log(`patrol down: nothing to tear down in fleet "${fleet}"`);
  }
}

// Per-fleet isolation for the teardown loop, and the seam its test needs. downOne throws
// whenever killSession does (a tmux kill-session that exits nonzero), and the bare `for` this
// replaces let ONE bad fleet abort the teardown of every fleet after it — under `--all`,
// silently: the throw surfaced as a generic CLI error naming no fleet, so the ones still
// running looked like they had been asked to stay. Returns the failure count; each is reported
// with its fleet so a human knows exactly what is still up.
//
// Separated from `down` because the failure it must survive cannot be provoked in a test
// without a real tmux server — the loop, not the tmux call, is what is being asserted.
export function downEach(fleets: string[], run: (fleet: string) => void): number {
  let failed = 0;
  for (const fleet of fleets) {
    try {
      run(fleet);
    } catch (e) {
      failed++;
      console.error(`patrol down: fleet "${fleet}" failed to tear down: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return failed;
}

export default async function down(args: string[]): Promise<number> {
  const force = args.includes("--force");
  const all = args.includes("--all");
  // The one positional is a fleet name; everything else is a flag read above.
  const positional = args.filter((a) => !a.startsWith("-"));
  if (positional.length > 1) {
    console.error(`patrol down: expected at most one fleet name (got ${positional.join(", ")})`);
    return 1;
  }

  const selection = selectFleetsToDown(
    { explicit: positional[0] ?? null, all },
    detectFleet(),
    knownFleets()
  );
  if ("error" in selection) {
    console.error(selection.error);
    return 1;
  }

  return downEach(selection.fleets, (fleet) => downOne(fleet, force)) > 0 ? 1 : 0;
}
