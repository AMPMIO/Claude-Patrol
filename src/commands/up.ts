// `patrol up [config]` — launch the fleet from patrol.yaml.
//
// Flow: parse + validate config -> read installed plugins -> per seat: plan,
// materialize any --settings / --mcp-config overlay to a stable per-seat file,
// compose exact argv+env -> dispatch to the seat's backend -> record a fleet
// state file so `patrol down` knows what to tear down.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { SEAT_TOKEN_RE } from "../../shared/types.ts";
import { parsePatrolConfig } from "../launcher/yaml.ts";
import {
  validateConfig, applyFleetBudget, planSeat, composeSeat, patrolMcpConfig, leaseFile, LEASE_DIR,
  type ComposePaths, type SeatPlan, type TmuxSeat, type RecordedBgSeat,
} from "../launcher/compose.ts";
import { hasSession, launchTmux } from "../launcher/tmux.ts";
import { fleetForConfig } from "../launcher/fleet-detect.ts";
import { fleetStateFileName, sessionName } from "../launcher/fleet.ts";
import { launchBg, listAgents } from "../launcher/bg.ts";
import { spawnSync } from "bun";

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const PROFILE_DIR = join(CONFIG_DIR, "patrol-profiles");
// v0.3: one state file PER FLEET. A single global fleet.json meant the second
// fleet to boot overwrote the first's bg-seat records, so the first `patrol down`
// had nothing to stop and those seats leaked.
function fleetStatePath(fleet: string): string {
  return join(PROFILE_DIR, fleetStateFileName(fleet));
}
// up.ts lives at src/commands/ ; seat-server.ts (W1) is at src/ under pkg root.
const PKG_ROOT = resolve(import.meta.dir, "../..");
const SEAT_SERVER = join(PKG_ROOT, "src", "seat-server.ts");

export interface FleetState {
  started_at: string;
  fleet: string;
  tmux: boolean;
  bg: RecordedBgSeat[];
}

// Layer-1 attribution token: "cp-" + 8 lowercase hex. The format contract lives
// in shared/types.ts (SEAT_TOKEN_RE) — generate here, then verify against it so a
// drift can never silently ship a token the broker won't content-match.
function genSeatToken(): string {
  const token = "cp-" + randomBytes(4).toString("hex");
  if (!SEAT_TOKEN_RE.test(token)) throw new Error(`bug: generated malformed seat token "${token}"`);
  return token;
}

// Per-LAUNCH lease id: 8 hex chars, enough that two fleets booting a same-named seat
// never collide on one lock file. Deliberately NOT the Layer-1 seat token — a `silent`
// seat has no seat token but still needs a lease path, and a lease id that doubled as
// the cost-attribution marker would leak into the seat's prompt.
export function genLaunchId(): string {
  return randomBytes(4).toString("hex");
}

function readInstalledPlugins(): Record<string, boolean> {
  const path = join(CONFIG_DIR, "settings.json");
  if (!existsSync(path)) return {};
  try {
    const s = JSON.parse(readFileSync(path, "utf8"));
    return s.enabledPlugins ?? {};
  } catch {
    return {};
  }
}

// Write the seat's --settings and --mcp-config overlays (if any) to stable,
// inspectable per-seat files and return their paths for argv composition.
// Stable (not temp) so a re-boot overwrites cleanly and humans can inspect —
// mirrors ccl keeping lite-settings.json around.
function materialize(plan: SeatPlan): ComposePaths {
  // A codex/headless adapter has no Claude settings or MCP surface. Avoid even
  // writing unused per-seat MCP files so its launch stays entirely adapter-owned.
  if (plan.backend === "codex" || plan.backend === "headless") {
    return { settingsFile: null, mcpConfigFile: null, leaseFile: null };
  }
  let settingsFile: string | null = null;
  if (plan.settingsOverlay) {
    settingsFile = join(PROFILE_DIR, `${plan.spec.name}.settings.json`);
    writeFileSync(settingsFile, JSON.stringify(plan.settingsOverlay, null, 1));
  }
  // Every participating seat needs the patrol seat-server mounted (that's what
  // registers it + auto-starts the broker). Only mcp:"none" opts out. compose
  // decides HOW to mount it: strict (patrol-only) for mcp:"patrol", additive
  // (patrol + the seat's global servers) for full/no-profile.
  let mcpConfigFile: string | null = null;
  if (plan.resolved?.mcp !== "none") {
    mcpConfigFile = join(PROFILE_DIR, `${plan.spec.name}.mcp.json`);
    writeFileSync(mcpConfigFile, patrolMcpConfig(SEAT_SERVER));
  }
  // v0.2.9.1: one lease path per seat LAUNCH, not per seat name. Two fleets each with a
  // seat called `builder` previously shared ~/.claude-patrol/leases/builder.lock, so one
  // fleet's checkpoint could unlink the other's lease and un-quiesce an unrelated seat.
  return { settingsFile, mcpConfigFile, leaseFile: leaseFile(plan.spec.name, genLaunchId()) };
}

export default async function up(args: string[]): Promise<number> {
  const configPath = resolve(args[0] ?? "patrol.yaml");
  if (!existsSync(configPath)) {
    console.error(`patrol up: config not found: ${configPath}`);
    return 1;
  }
  const configDir = dirname(configPath);

  let config;
  try {
    config = parsePatrolConfig(readFileSync(configPath, "utf8"));
    validateConfig(config);
  } catch (e) {
    console.error(`patrol up: ${(e as Error).message}`);
    return 1;
  }

  // Resolve the fleet ONCE, here, through the shared resolver — `patrol down`
  // and the CLI's seat resolution call the same function, so teardown can never
  // target a session `up` did not create.
  let fleet: string;
  try {
    fleet = fleetForConfig(configPath, config.fleet);
  } catch (e) {
    console.error(`patrol up: ${(e as Error).message}`);
    return 1;
  }
  const session = sessionName(fleet);

  const installed = readInstalledPlugins();
  // Fold the fleet-level budget_usd into each seat as its default cap before planning,
  // so a seat without its own SeatSpec.budget_usd inherits the fleet cap (Codex #2).
  const seats = applyFleetBudget(config);
  const plans = seats.map((s) => planSeat(s, installed, configDir));

  // Codex + headless adapter seats intentionally run as visible tmux windows too;
  // tmux session teardown therefore stops them along with ordinary tmux seats.
  const tmuxSeats = plans.filter((p) => p.backend === "tmux" || p.backend === "codex" || p.backend === "headless");
  if (tmuxSeats.length > 0 && hasSession(fleet)) {
    console.error(`patrol up: tmux session "${session}" already exists — run \`patrol down\` first (other fleets are unaffected)`);
    return 1;
  }

  mkdirSync(PROFILE_DIR, { recursive: true });
  // v0.2.9.1: the lease dir must exist BEFORE any seat boots. checkpoint used to write
  // the lock straight into it, so on a clean install the first guarded checkpoint threw
  // ENOENT *after* acquiring the broker lease — a seat quiesced in the broker's record
  // while nothing on disk was actually guarding it. 0700 because the file's presence is
  // what freezes a seat: another user must not be able to drop one in.
  mkdirSync(LEASE_DIR, { recursive: true, mode: 0o700 });

  // Compose everything before launching so a compose error aborts cleanly.
  // One fresh token per non-silent seat; silent seats pass null (Layer-3 only).
  const composed = plans.map((plan) => {
    const paths = materialize(plan);
    const token = plan.spec.silent ? null : genSeatToken();
    return { plan, token, ...composeSeat(plan, paths, token, config.budget_alert_to ?? null, fleet) };
  });

  // tmux seats
  const tmuxLaunch: TmuxSeat[] = composed
    .filter((c) => c.plan.backend === "tmux" || c.plan.backend === "codex" || c.plan.backend === "headless")
    .map((c) => ({ name: c.plan.spec.name, cwd: c.plan.cwd, env: c.env, argv: c.argv }));
  if (tmuxLaunch.length > 0) {
    launchTmux(tmuxLaunch, fleet);
    console.log(`patrol up: ${tmuxLaunch.length} tmux seat(s) in session "${session}" — attach with \`tmux attach -t ${session}\``);
  }

  // bg seats: snapshot before, launch, diff to capture fresh agents by name
  const bgComposed = composed.filter((c) => c.plan.backend === "bg");
  const bgRecorded: RecordedBgSeat[] = [];
  if (bgComposed.length > 0) {
    const before = new Set(listAgents().map((a) => a.sessionId));
    for (const c of bgComposed) {
      launchBg(c.plan.cwd, c.env, c.argv);
    }
    const fresh = listAgents().filter((a) => !before.has(a.sessionId));
    for (const c of bgComposed) {
      const hit = fresh.find((a) => a.name === c.plan.spec.name);
      bgRecorded.push({ name: c.plan.spec.name, sessionId: hit?.sessionId ?? null, pid: hit?.pid ?? null, token: c.token });
    }
    console.log(`patrol up: ${bgComposed.length} bg seat(s) dispatched — list with \`claude agents --json\``);
  }

  // current seats: run in the foreground of this terminal (sequential; edge case)
  // ponytail: a fleet with >1 `current` seat is nonsensical; we just run them
  // in order and let the last take over the terminal.
  for (const c of composed.filter((c) => c.plan.backend === "current")) {
    console.log(`patrol up: running "${c.plan.spec.name}" in current terminal`);
    spawnSync(c.argv, { cwd: c.plan.cwd, env: { ...process.env, ...c.env }, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  }

  const state: FleetState = { started_at: new Date().toISOString(), fleet, tmux: tmuxLaunch.length > 0, bg: bgRecorded };
  writeFileSync(fleetStatePath(fleet), JSON.stringify(state, null, 1));
  return 0;
}
