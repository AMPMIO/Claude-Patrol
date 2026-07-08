// tmux backend — executes the pure command list from compose.tmuxCommands().
// Session model: one session "patrol", one window per seat (window name = seat
// name), each window running the seat's composed `claude` line via send-keys.

import { spawnSync } from "bun";
import { TMUX_SESSION, tmuxCommands, type TmuxSeat } from "./compose.ts";

function tmux(args: string[]): { ok: boolean; stderr: string } {
  const r = spawnSync(["tmux", ...args]);
  return { ok: r.exitCode === 0, stderr: r.stderr?.toString() ?? "" };
}

export function hasSession(): boolean {
  return tmux(["has-session", "-t", TMUX_SESSION]).ok;
}

export function killSession(): boolean {
  if (!hasSession()) return false;
  const r = tmux(["kill-session", "-t", TMUX_SESSION]);
  if (!r.ok) throw new Error(`tmux kill-session failed: ${r.stderr}`);
  return true;
}

export function launchTmux(seats: TmuxSeat[]): void {
  for (const cmd of tmuxCommands(seats)) {
    const r = tmux(cmd);
    if (!r.ok) throw new Error(`tmux ${cmd[0]} failed: ${r.stderr}`);
  }
}
