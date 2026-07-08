// `patrol down` — tear down what `patrol up` started: kill the tmux "patrol"
// session and stop bg seats. Seats deregister from the broker via the W1
// SessionEnd hook within the broker's grace window; down only stops processes.

import { readFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { selectBgPidsToKill } from "../launcher/compose.ts";
import { killSession } from "../launcher/tmux.ts";
import { listAgents } from "../launcher/bg.ts";
import type { FleetState } from "./up.ts";

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const FLEET_STATE = join(CONFIG_DIR, "patrol-profiles", "fleet.json");

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

export default async function down(args: string[]): Promise<number> {
  const force = args.includes("--force");
  let state: FleetState | null = null;
  if (existsSync(FLEET_STATE)) {
    try {
      state = JSON.parse(readFileSync(FLEET_STATE, "utf8"));
    } catch {
      console.error("patrol down: fleet state file is corrupt — killing tmux session best-effort");
    }
  }

  // tmux: kill the session if present (even without state, in case it leaked).
  const killed = killSession();
  if (killed) console.log(`patrol down: killed tmux session "patrol"`);

  // bg: stop recorded seats. Re-query live agents so we kill the right pids.
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
    console.log(`patrol down: stopped ${stopped}/${state.bg.length} bg seat(s)`);
  }

  if (existsSync(FLEET_STATE)) rmSync(FLEET_STATE);
  if (!killed && !state?.bg?.length) {
    console.log("patrol down: nothing to tear down");
  }
  return 0;
}
