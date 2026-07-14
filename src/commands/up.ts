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
  validateConfig, planSeat, composeSeat, patrolMcpConfig,
  type ComposePaths, type SeatPlan, type TmuxSeat, type RecordedBgSeat,
} from "../launcher/compose.ts";
import { hasSession, launchTmux } from "../launcher/tmux.ts";
import { launchBg, listAgents } from "../launcher/bg.ts";
import { spawnSync } from "bun";

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const PROFILE_DIR = join(CONFIG_DIR, "patrol-profiles");
const FLEET_STATE = join(PROFILE_DIR, "fleet.json");
// up.ts lives at src/commands/ ; seat-server.ts (W1) is at src/ under pkg root.
const PKG_ROOT = resolve(import.meta.dir, "../..");
const SEAT_SERVER = join(PKG_ROOT, "src", "seat-server.ts");

export interface FleetState {
  started_at: string;
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
  // A codex adapter has no Claude settings or MCP surface. Avoid even writing
  // unused per-seat MCP files so its launch remains entirely adapter-owned.
  if (plan.backend === "codex") return { settingsFile: null, mcpConfigFile: null };
  let settingsFile: string | null = null;
  if (plan.settingsOverlay) {
    settingsFile = join(PROFILE_DIR, `${plan.spec.name}.settings.json`);
    writeFileSync(settingsFile, JSON.stringify(plan.settingsOverlay, null, 1));
  }
  let mcpConfigFile: string | null = null;
  if (plan.resolved?.mcp === "patrol") {
    mcpConfigFile = join(PROFILE_DIR, `${plan.spec.name}.mcp.json`);
    writeFileSync(mcpConfigFile, patrolMcpConfig(SEAT_SERVER));
  }
  return { settingsFile, mcpConfigFile };
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

  const installed = readInstalledPlugins();
  const plans = config.seats.map((s) => planSeat(s, installed, configDir));

  // Codex adapter seats intentionally run as visible tmux windows too; tmux
  // session teardown therefore stops them along with ordinary tmux seats.
  const tmuxSeats = plans.filter((p) => p.backend === "tmux" || p.backend === "codex");
  if (tmuxSeats.length > 0 && hasSession()) {
    console.error(`patrol up: tmux session "patrol" already exists — run \`patrol down\` first`);
    return 1;
  }

  mkdirSync(PROFILE_DIR, { recursive: true });

  // Compose everything before launching so a compose error aborts cleanly.
  // One fresh token per non-silent seat; silent seats pass null (Layer-3 only).
  const composed = plans.map((plan) => {
    const paths = materialize(plan);
    const token = plan.spec.silent ? null : genSeatToken();
    return { plan, token, ...composeSeat(plan, paths, token) };
  });

  // tmux seats
  const tmuxLaunch: TmuxSeat[] = composed
    .filter((c) => c.plan.backend === "tmux" || c.plan.backend === "codex")
    .map((c) => ({ name: c.plan.spec.name, cwd: c.plan.cwd, env: c.env, argv: c.argv }));
  if (tmuxLaunch.length > 0) {
    launchTmux(tmuxLaunch);
    console.log(`patrol up: ${tmuxLaunch.length} tmux seat(s) in session "patrol" — attach with \`tmux attach -t patrol\``);
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

  const state: FleetState = { started_at: new Date().toISOString(), tmux: tmuxLaunch.length > 0, bg: bgRecorded };
  writeFileSync(FLEET_STATE, JSON.stringify(state, null, 1));
  return 0;
}
