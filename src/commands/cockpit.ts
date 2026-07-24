// patrol cockpit — fold the running "patrol" fleet (today one tmux window per
// seat) into a single "cockpit" window: main-horizontal layout (the focused seat
// big on top, the rest tiled below as labelled live previews). This is an
// alternate VIEW invoked on demand; `patrol up` is unchanged. Idempotent: a
// re-run re-applies the layout rather than erroring or duplicating.

import { spawnSync } from "bun";
import { TMUX_SESSION } from "../launcher/compose.ts";
import { hasSession } from "../launcher/tmux.ts";

const COCKPIT_WINDOW = "cockpit";

// Prefix-table key that promotes the focused preview into the big top slot
// (swap-pane with the main pane). tmux key tables are SERVER-global, not
// per-session, so this key is chosen from tmux's UNBOUND default prefix keys —
// it must not clobber a useful default (Space=next-layout is one we must not
// steal). Advertised in the status bar so it stays discoverable.
export const PROMOTE_KEY = "P";

// Shown in the patrol session's status bar. Every key here is a Ctrl-b (prefix)
// chord: ↑↓/o and z are tmux natives; P is our one added binding.
export const STATUS_HINTS = ` cockpit · ↑↓/o focus · z zoom · ${PROMOTE_KEY} main · d detach `;

// Per-preview label. The seat name is carried on a pane-scoped user option
// (@seat) rather than #{pane_title} because the running `claude` owns its pane
// title and would overwrite a title we set — a user option it never touches.
const PANE_BORDER_FORMAT = " #{pane_index} #{@seat} ";

// --- pure tmux command sequence (unit-tested; tmux is never touched here) ----

// The exact tmux argv sequence that folds `seatWindows` into the cockpit window
// and (re)applies the cockpit view. `cockpitExists` is the idempotency switch:
// with no cockpit yet, the FIRST seat window becomes the cockpit (rename, no
// join) and the rest join into it; with a cockpit already present, nothing is
// renamed and only straggler windows (usually none) are folded in — so a plain
// re-run just re-applies layout + chrome.
export function cockpitCommands(seatWindows: string[], cockpitExists: boolean): string[][] {
  const S = TMUX_SESSION;
  const target = `${S}:${COCKPIT_WINDOW}`;
  const cmds: string[][] = [];

  let foldStart = 0;
  if (!cockpitExists) {
    const first = seatWindows[0];
    if (first !== undefined) {
      // Label the pane BEFORE the rename, while it is still addressable by its
      // seat-window name; pane options travel with the pane through join-pane.
      cmds.push(["set-option", "-p", "-t", `${S}:${first}`, "@seat", first]);
      cmds.push(["rename-window", "-t", `${S}:${first}`, COCKPIT_WINDOW]);
    }
    foldStart = 1;
  }
  for (let i = foldStart; i < seatWindows.length; i++) {
    const w = seatWindows[i]!;
    cmds.push(["set-option", "-p", "-t", `${S}:${w}`, "@seat", w]);
    // join-pane MOVES the pane (with its live claude process) into the cockpit
    // window — it does not kill or restart it.
    cmds.push(["join-pane", "-s", `${S}:${w}`, "-t", target]);
  }

  // Big main pane on top, the rest tiled in a row below.
  cmds.push(["select-layout", "-t", target, "main-horizontal"]);
  // Label every preview with its handle + index.
  cmds.push(["set-option", "-w", "-t", target, "pane-border-status", "top"]);
  cmds.push(["set-option", "-w", "-t", target, "pane-border-format", PANE_BORDER_FORMAT]);
  // Key hints inline. status-* options are session-scoped (-t patrol) so they do
  // not touch the user's other tmux sessions.
  cmds.push(["set-option", "-t", S, "status-left", STATUS_HINTS]);
  cmds.push(["set-option", "-t", S, "status-left-length", "160"]);
  // The one added binding (server-global — see PROMOTE_KEY). {top-left} is the
  // main pane in main-horizontal; swap-pane with no -s uses the active pane.
  cmds.push(["bind-key", PROMOTE_KEY, "swap-pane", "-t", "{top-left}"]);
  // Land on the cockpit window when the user attaches.
  cmds.push(["select-window", "-t", target]);
  return cmds;
}

// --- tmux execution (impure) -------------------------------------------------

function tmux(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(["tmux", ...args]);
  return { ok: r.exitCode === 0, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "" };
}

function listWindows(): string[] {
  const r = tmux(["list-windows", "-t", TMUX_SESSION, "-F", "#{window_name}"]);
  if (!r.ok) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

function paneCount(): number {
  const r = tmux(["list-panes", "-t", `${TMUX_SESSION}:${COCKPIT_WINDOW}`, "-F", "#{pane_id}"]);
  if (!r.ok) return 0;
  return r.stdout.split("\n").filter((s) => s.trim().length > 0).length;
}

export default async function cockpit(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`patrol cockpit — fold the running fleet into one cockpit window

Rearranges the live "patrol" tmux session so every seat is a PANE in a single
"cockpit" window instead of a full-screen window each: the focused seat big on
top, the rest tiled below as labelled live previews. Running claude processes are
moved, not restarted. Idempotent — re-run any time to re-apply the layout.

Keys (all Ctrl-b chords):
  ↑ ↓ / o   move focus between panes            (tmux native)
  z         zoom the focused seat to fullscreen  (tmux native)
  ${PROMOTE_KEY}         promote the focused preview into the big top slot
  d         detach

Note: ${PROMOTE_KEY} is a tmux key binding, which is server-global (tmux has no
per-session bindings). It is chosen from tmux's unbound prefix keys so it clobbers
no default.`);
    return 0;
  }

  if (!hasSession()) {
    console.error("patrol cockpit: no patrol session — run `patrol up` first");
    return 1;
  }

  const windows = listWindows();
  const cockpitExists = windows.includes(COCKPIT_WINDOW);
  const seatWindows = windows.filter((w) => w !== COCKPIT_WINDOW);

  for (const cmd of cockpitCommands(seatWindows, cockpitExists)) {
    const r = tmux(cmd);
    // The structural moves are load-bearing; the chrome (borders, status, bind)
    // is cosmetic and must not abort a view whose seats are already folded in.
    if (!r.ok && (cmd[0] === "rename-window" || cmd[0] === "join-pane" || cmd[0] === "select-layout")) {
      console.error(`patrol cockpit: tmux ${cmd[0]} failed: ${r.stderr.trim()}`);
      return 1;
    }
  }

  console.log(
    `patrol cockpit: ${paneCount()} seat(s) in cockpit view — attach with \`tmux attach -t patrol\`\n  ${STATUS_HINTS.trim()}`
  );
  return 0;
}
