// Pure launcher core: validate a PatrolConfig, compose the exact `claude` argv
// + env per seat, and derive the tmux command list + bg teardown selection.
// Nothing here spawns a process or touches disk — that lives in tmux.ts / bg.ts
// / up.ts. Keeping it pure is what makes tests/launcher.test.ts able to assert
// exact argv without a real tmux or claude.

import type { PatrolConfig, SeatSpec } from "../../shared/types.ts";
import { resolveProfile, buildSettingsOverlay, PRESET_NAMES, NAMED_PROFILES, type ResolvedProfile } from "../profiles.ts";

export const TMUX_SESSION = "patrol";
const EMPTY_MCP = '{"mcpServers":{}}';

export interface SeatPlan {
  spec: SeatSpec;
  role: string;
  cwd: string;
  backend: "tmux" | "bg" | "current";
  resolved: ResolvedProfile | null;
  settingsOverlay: Record<string, unknown> | null;
}

// --- validation -------------------------------------------------------------

// Fail the whole fleet before launching anything if any seat is malformed.
// The model guard is the load-bearing one: it blocks the measured $3.6–4.9/seat
// Fable-default boot leak (DESIGN.md D4.2).
export function validateConfig(config: PatrolConfig): void {
  if (!config.seats || config.seats.length === 0) {
    throw new Error("patrol.yaml has no seats");
  }
  const seen = new Set<string>();
  for (const seat of config.seats) {
    const name = seat.name;
    if (!name || typeof name !== "string") {
      throw new Error("every seat needs a non-empty `name`");
    }
    if (seen.has(name)) {
      throw new Error(`duplicate seat name "${name}" (names must be unique — they become tmux window names)`);
    }
    seen.add(name);
    if (!seat.model || typeof seat.model !== "string") {
      throw new Error(`seat "${name}" has no model — a seat never boots on the default model (would leak the Fable default)`);
    }
    const backend = seat.backend ?? "tmux";
    if (backend !== "tmux" && backend !== "bg" && backend !== "current") {
      throw new Error(`seat "${name}" has invalid backend "${backend}" (expected tmux | bg | current)`);
    }
    if (backend === "current" && seat.profile !== undefined) {
      throw new Error(`seat "${name}" uses backend "current" with a profile — a running session cannot be re-profiled; drop the profile or change the backend`);
    }
    // A string profile must name a known preset — caught here so a bad name is a
    // clean config error, not a crash later in planSeat/resolveProfile.
    if (typeof seat.profile === "string" && !(seat.profile in NAMED_PROFILES)) {
      throw new Error(`seat "${name}" has unknown profile "${seat.profile}" (expected ${PRESET_NAMES.join(" | ")}, or an inline profile map)`);
    }
  }
}

// --- planning + argv composition -------------------------------------------

export function planSeat(seat: SeatSpec, installedPlugins: Record<string, boolean>, configDir: string): SeatPlan {
  const resolved = resolveProfile(seat.profile);
  const settingsOverlay = resolved ? buildSettingsOverlay(resolved, installedPlugins) : null;
  return {
    spec: seat,
    role: seat.role ?? seat.name,
    cwd: seat.cwd ?? configDir,
    backend: seat.backend ?? "tmux",
    resolved,
    settingsOverlay,
  };
}

export interface ComposePaths {
  settingsFile: string | null; // where the overlay was written; null if no overlay
  mcpConfigFile: string | null; // patrol seat-server config path; null unless mcp=patrol
}

export interface Composed {
  argv: string[];
  env: Record<string, string>;
}

// Exact `claude` argv + patrol env for one planned seat. Order is fixed so
// tests can assert it verbatim: model, name, [--bg], mcp flags, settings, prompt.
export function composeSeat(plan: SeatPlan, paths: ComposePaths): Composed {
  const { spec, resolved } = plan;
  const argv = ["claude", "--model", spec.model, "--name", spec.name];

  if (plan.backend === "bg") argv.push("--bg");

  const mcp = resolved?.mcp;
  if (mcp === "none") {
    argv.push("--strict-mcp-config", "--mcp-config", EMPTY_MCP);
  } else if (mcp === "patrol") {
    if (!paths.mcpConfigFile) throw new Error(`seat "${spec.name}" needs mcp=patrol config file path`);
    argv.push("--strict-mcp-config", "--mcp-config", paths.mcpConfigFile);
  } // mcp === "full" or no profile -> inherit configured MCP servers, no flags

  if (paths.settingsFile) argv.push("--settings", paths.settingsFile);

  if (spec.prompt) argv.push(spec.prompt);

  const env: Record<string, string> = {
    CLAUDE_PATROL_ROLE: plan.role,
    CLAUDE_PATROL_MODEL: spec.model,
  };
  if (spec.profile !== undefined) {
    env.CLAUDE_PATROL_PROFILE = typeof spec.profile === "string" ? spec.profile : "custom";
  }
  return { argv, env };
}

// MCP config JSON pointing at W1's patrol seat server. seat-server.ts is W1's
// file — referenced by path only, never edited. This is the W1<->W2 seam;
// review this pairing hardest at integration.
export function patrolMcpConfig(seatServerPath: string): string {
  return JSON.stringify({
    mcpServers: { patrol: { command: "bun", args: [seatServerPath] } },
  });
}

// --- shell quoting (for tmux send-keys, which passes a literal shell line) ---

// Single-quote wrap, escaping embedded single quotes. This is a trust boundary:
// prompts, cwds and file paths are arbitrary strings that get parsed by the
// shell inside the window, so quoting must be exact.
export function shQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_./:=@-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Full shell line for a seat: `cd <cwd> && env K=v ... claude ...`.
export function seatShellLine(cwd: string, env: Record<string, string>, argv: string[]): string {
  const envParts = Object.entries(env).map(([k, v]) => `${k}=${shQuote(v)}`);
  const cmd = argv.map(shQuote).join(" ");
  const envPrefix = envParts.length > 0 ? `env ${envParts.join(" ")} ` : "";
  return `cd ${shQuote(cwd)} && ${envPrefix}${cmd}`;
}

// --- tmux command list (pure data; tmux.ts executes it) --------------------

export interface TmuxSeat {
  name: string;
  cwd: string;
  env: Record<string, string>;
  argv: string[];
}

// The exact sequence of tmux argv arrays to stand up the fleet: one detached
// session, first window named after seat[0], a new-window per remaining seat,
// and a send-keys per seat running its composed command.
export function tmuxCommands(seats: TmuxSeat[]): string[][] {
  const cmds: string[][] = [];
  seats.forEach((seat, idx) => {
    if (idx === 0) {
      cmds.push(["new-session", "-d", "-s", TMUX_SESSION, "-n", seat.name]);
    } else {
      cmds.push(["new-window", "-t", TMUX_SESSION, "-n", seat.name]);
    }
    const target = `${TMUX_SESSION}:${seat.name}`;
    cmds.push(["send-keys", "-t", target, seatShellLine(seat.cwd, seat.env, seat.argv), "Enter"]);
  });
  return cmds;
}

// --- bg teardown selection (pure) ------------------------------------------

export interface RecordedBgSeat {
  name: string;
  sessionId: string | null;
  pid: number | null;
}
export interface LiveAgent {
  pid: number;
  sessionId: string;
  name: string;
}

// Pids to kill on `patrol down`: match recorded bg seats against the live
// `claude agents --json` list by sessionId first, then by name, so a recycled
// pid is never killed by mistake.
export function selectBgPidsToKill(recorded: RecordedBgSeat[], live: LiveAgent[]): number[] {
  const pids: number[] = [];
  for (const rec of recorded) {
    const hit =
      (rec.sessionId && live.find((a) => a.sessionId === rec.sessionId)) ||
      live.find((a) => a.name === rec.name);
    if (hit) pids.push(hit.pid);
    else if (rec.pid) pids.push(rec.pid); // fallback: agent already gone from list
  }
  return [...new Set(pids)];
}
