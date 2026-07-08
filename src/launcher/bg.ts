// Background backend — `claude --bg` headless seats managed via `claude agents`.
// claude --bg returns immediately after dispatching; the real agent pid/session
// shows up in `claude agents --json`, which we query to record teardown handles.

import { spawnSync } from "bun";
import type { LiveAgent } from "./compose.ts";

// Launch one headless seat. env is layered onto the current environment so the
// seat inherits PATH etc. but gets its CLAUDE_PATROL_* identity.
export function launchBg(cwd: string, env: Record<string, string>, argv: string[]): void {
  const [cmd, ...args] = argv;
  const r = spawnSync([cmd!, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (r.exitCode !== 0) {
    throw new Error(`bg seat dispatch failed (exit ${r.exitCode})`);
  }
}

export function listAgents(): LiveAgent[] {
  const r = spawnSync(["claude", "agents", "--json"]);
  if (r.exitCode !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout.toString());
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((a) => a && typeof a.pid === "number" && typeof a.sessionId === "string")
      .map((a) => ({ pid: a.pid, sessionId: a.sessionId, name: a.name ?? "" }));
  } catch {
    return [];
  }
}
