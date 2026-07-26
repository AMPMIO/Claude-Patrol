// tmux backend — executes the pure command list from compose.tmuxCommands().
// Session model: one session per FLEET (`patrol-<fleet>`), one window per seat
// (window name = seat name), each window running the seat's composed `claude`
// line via send-keys.
//
// Every target is the `=`-exact form (see fleet.ts): tmux resolves a plain -t by
// exact name and then by PREFIX, so an inexact target lets one fleet's teardown
// land on a neighbouring fleet's session — the v0.3 bug in miniature.

import { spawnSync } from "bun";
import { exactSession } from "./fleet.ts";
import { tmuxCommands, type TmuxSeat } from "./compose.ts";

function tmux(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(["tmux", ...args]);
  return { ok: r.exitCode === 0, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "" };
}

export function hasSession(fleet: string): boolean {
  return tmux(["has-session", "-t", exactSession(fleet)]).ok;
}

export function killSession(fleet: string): boolean {
  if (!hasSession(fleet)) return false;
  const r = tmux(["kill-session", "-t", exactSession(fleet)]);
  if (!r.ok) throw new Error(`tmux kill-session failed: ${r.stderr}`);
  return true;
}

// Every tmux session name on this machine. `patrol down` needs it to tell "your
// fleet isn't running" from "your fleet isn't running but someone else's is" —
// the second case must refuse, not kill whatever it can find.
export function listSessionNames(): string[] {
  const r = tmux(["list-sessions", "-F", "#{session_name}"]);
  if (!r.ok) return []; // no tmux server == no sessions
  return r.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

export function launchTmux(seats: TmuxSeat[], fleet: string): void {
  for (const cmd of tmuxCommands(seats, fleet)) {
    const r = tmux(cmd);
    if (!r.ok) throw new Error(`tmux ${cmd[0]} failed: ${r.stderr}`);
  }
}
