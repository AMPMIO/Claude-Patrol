// Pure launcher core: validate a PatrolConfig, compose the exact `claude` argv
// + env per seat, and derive the tmux command list + bg teardown selection.
// Nothing here spawns a process or touches disk — that lives in tmux.ts / bg.ts
// / up.ts. Keeping it pure is what makes tests/launcher.test.ts able to assert
// exact argv without a real tmux or claude.

import { resolve } from "node:path";
import { seatMarker, SEAT_TOKEN_ENV, type PatrolConfig, type SeatSpec } from "../../shared/types.ts";
import { resolveProfile, buildSettingsOverlay, PRESET_NAMES, NAMED_PROFILES, type ResolvedProfile } from "../profiles.ts";

export const TMUX_SESSION = "patrol";
// Kept here (rather than in up.ts) so composeSeat remains pure and callers can
// assert the executable adapter path without touching the filesystem.
export const CODEX_SEAT = resolve(import.meta.dir, "../codex-seat.ts");
export const HEADLESS_SEAT = resolve(import.meta.dir, "../headless-seat.ts");
const EMPTY_MCP = '{"mcpServers":{}}';

// A seat name becomes a filesystem path segment (per-seat overlay files) and a
// tmux `-t patrol:<name>` target, so a name from a possibly-cloned untrusted
// patrol.yaml is a path-traversal / target-injection vector. shQuote protects
// the shell LINE but neither the join() nor the tmux target — hence this slug.
const SEAT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface SeatPlan {
  spec: SeatSpec;
  role: string;
  cwd: string;
  // Derived from the frozen contract — never restate the union here, or a new
  // backend silently fails to typecheck at exactly one call site.
  backend: NonNullable<SeatSpec["backend"]>;
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
    if (!SEAT_NAME_RE.test(name) || name === "." || name === "..") {
      throw new Error(`seat "${name}" has an invalid name — must match ${SEAT_NAME_RE} and not be "." or ".." (the name becomes a file path and tmux target)`);
    }
    if (seen.has(name)) {
      throw new Error(`duplicate seat name "${name}" (names must be unique — they become tmux window names)`);
    }
    seen.add(name);
    if (!seat.model || typeof seat.model !== "string") {
      throw new Error(`seat "${name}" has no model — a seat never boots on the default model (would leak the Fable default)`);
    }
    const backend = seat.backend ?? "tmux";
    if (backend !== "tmux" && backend !== "bg" && backend !== "current" && backend !== "codex" && backend !== "headless") {
      throw new Error(`seat "${name}" has invalid backend "${backend}" (expected tmux | bg | current | codex | headless)`);
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
    // A relative cwd is resolved against the config file's directory, not the
    // process cwd — `patrol up ../other/patrol.yaml` must launch seats relative
    // to that config, not wherever the user happened to run the command.
    cwd: seat.cwd ? resolve(configDir, seat.cwd) : configDir,
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
// seatToken is the Layer-1 cost-attribution marker (see below); pass null (or
// omit) to compose without one. Kept pure — the token is a parameter, never
// generated here — so tests can assert the exact argv+env.
export function composeSeat(plan: SeatPlan, paths: ComposePaths, seatToken: string | null = null): Composed {
  const { spec, resolved } = plan;

  // Codex seats are broker adapters, not Claude sessions. They deliberately
  // receive no Claude argv, marker, settings, or MCP configuration.
  if (plan.backend === "codex") {
    const argv = ["bun", CODEX_SEAT, "--cwd", plan.cwd, "--role", plan.role, "--model", spec.model];
    if (spec.prompt) argv.push("--prompt", spec.prompt);
    return {
      argv,
      env: {
        CLAUDE_PATROL_ROLE: plan.role,
        CLAUDE_PATROL_MODEL: spec.model,
      },
    };
  }

  // Headless seats are also broker adapter daemons (bun, not `claude` sessions):
  // the adapter itself drives `claude -p --resume` per turn, so like codex it takes
  // no Claude marker/settings/MCP argv — its launch is entirely adapter-owned.
  if (plan.backend === "headless") {
    const argv = ["bun", HEADLESS_SEAT, "--cwd", plan.cwd, "--role", plan.role, "--model", spec.model];
    if (spec.prompt) argv.push("--prompt", spec.prompt);
    return {
      argv,
      env: {
        CLAUDE_PATROL_ROLE: plan.role,
        CLAUDE_PATROL_MODEL: spec.model,
      },
    };
  }

  const argv = ["claude", "--model", spec.model, "--name", spec.name];

  if (plan.backend === "bg") argv.push("--bg");

  const mcp = resolved?.mcp;
  if (mcp === "none") {
    argv.push("--strict-mcp-config", "--mcp-config", EMPTY_MCP);
  } else if (mcp === "patrol") {
    // Patrol ONLY (strict) — the explicit lean choice; drops the user's global MCP.
    if (!paths.mcpConfigFile) throw new Error(`seat "${spec.name}" needs mcp=patrol config file path`);
    argv.push("--strict-mcp-config", "--mcp-config", paths.mcpConfigFile);
  } else {
    // full or no profile: mount patrol ADDITIVELY (NO --strict) so the seat keeps
    // its inherited global MCP servers (serena, playwright, …) AND still gets the
    // patrol seat-server that registers it and auto-starts the broker. Without
    // this, a full-toolchain seat has no seat-server and silently never joins the
    // fleet — the broker never starts and `patrol list` reports unreachable.
    if (!paths.mcpConfigFile) throw new Error(`seat "${spec.name}" needs a patrol mcp-config file path`);
    argv.push("--mcp-config", paths.mcpConfigFile);
  }

  // Channel push is a research-preview CC capability: without this flag the
  // seat's MCP tools still work but inbound messages never wake the session
  // (delivery silently degrades to the manual check_messages fallback). The
  // "patrol" entry name matches both patrolMcpConfig and the plugin .mcp.json.
  if (mcp !== "none") {
    argv.push("--dangerously-load-development-channels", "server:patrol");
  }

  if (paths.settingsFile) argv.push("--settings", paths.settingsFile);

  // Layer-1 attribution: inject the seat token into BOTH the launch prompt (so
  // it lands in the session jsonl the broker content-matches on) and the env.
  // `silent` seats opt out of both and stay on Layer-3 heuristic attribution.
  const marker = seatToken != null && spec.silent !== true ? seatMarker(seatToken) : null;
  const promptArg = spec.prompt
    ? (marker ? `${spec.prompt}\n\n${marker}` : spec.prompt)
    : (marker ? `${marker} You are seat ${plan.role}. Await instructions.` : null);
  // The prompt is a trailing POSITIONAL. `--dangerously-load-development-channels`
  // above is variadic and, unless a flag follows it, slurps the prompt as another
  // (untagged) channel entry → claude errors out and the seat never boots. This bit
  // every `mcp:"full"`/no-profile seat (no --settings/--mcp-config to bound it).
  // `--` ends option parsing so the prompt is always a clean positional; it's a
  // harmless no-op when no variadic precedes it.
  if (promptArg !== null) argv.push("--", promptArg);

  const env: Record<string, string> = {
    CLAUDE_PATROL_ROLE: plan.role,
    CLAUDE_PATROL_MODEL: spec.model,
  };
  if (spec.profile !== undefined) {
    env.CLAUDE_PATROL_PROFILE = typeof spec.profile === "string" ? spec.profile : "custom";
  }
  // v0.2.6: carry the per-seat spend cap to the seat-server, which forwards it in
  // /register. An env var (not a new argv flag) keeps composeSeat pure and this change
  // localized to the existing CLAUDE_PATROL_* block — codex/headless adapter seats
  // (which bill externally / return early above) are intentionally out of scope.
  if (spec.budget_usd != null) env.CLAUDE_PATROL_BUDGET_USD = String(spec.budget_usd);
  if (marker) env[SEAT_TOKEN_ENV] = seatToken!;
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
  token?: string | null; // Layer-1 seat token (null for silent seats); for inspection/attribution
}
export interface LiveAgent {
  pid: number;
  sessionId: string;
  name: string;
}

// Split of `patrol down` kill candidates. Pids that still match a live `claude
// agents --json` entry are `verified` and safe to signal. Pids that only survive
// as a recorded value (their agent is gone from the live list) are `unverified`:
// the OS may have recycled the pid onto an unrelated process, so the caller must
// confirm it still looks like our claude before signalling.
export interface BgKillPlan {
  verified: number[];
  unverified: number[];
}

// Match recorded bg seats against the live `claude agents --json` list by
// sessionId first, then by name. A live match is verified; a recorded-pid
// fallback is unverified (recycle risk) so `patrol down` never blindly kills it.
export function selectBgPidsToKill(recorded: RecordedBgSeat[], live: LiveAgent[]): BgKillPlan {
  const verified: number[] = [];
  const unverified: number[] = [];
  for (const rec of recorded) {
    const hit =
      (rec.sessionId && live.find((a) => a.sessionId === rec.sessionId)) ||
      live.find((a) => a.name === rec.name);
    if (hit) verified.push(hit.pid);
    else if (rec.pid) unverified.push(rec.pid);
  }
  const uniq = (xs: number[]) => [...new Set(xs)];
  const v = uniq(verified);
  const vset = new Set(v);
  return { verified: v, unverified: uniq(unverified).filter((p) => !vset.has(p)) };
}
