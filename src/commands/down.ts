// `patrol down` — tear down what `patrol up` started: kill the tmux "patrol"
// session and stop bg seats. Seats deregister from the broker via the W1
// SessionEnd hook within the broker's grace window; down only stops processes.

import { readFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { selectBgPidsToKill } from "../launcher/compose.ts";
import { killSession } from "../launcher/tmux.ts";
import { listAgents } from "../launcher/bg.ts";
import type { FleetState } from "./up.ts";

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const FLEET_STATE = join(CONFIG_DIR, "patrol-profiles", "fleet.json");

export default async function down(_args: string[]): Promise<number> {
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
    const pids = selectBgPidsToKill(state.bg, listAgents());
    let stopped = 0;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
        stopped++;
      } catch {
        // already gone
      }
    }
    console.log(`patrol down: stopped ${stopped}/${state.bg.length} bg seat(s)`);
  }

  if (existsSync(FLEET_STATE)) rmSync(FLEET_STATE);
  if (!killed && !state?.bg?.length) {
    console.log("patrol down: nothing to tear down");
  }
  return 0;
}
