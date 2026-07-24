#!/usr/bin/env bun
// patrol CLI — thin dispatcher. Each subcommand lives in src/commands/<name>.ts
// and default-exports (args: string[]) => Promise<number>.

const COMMANDS = ["up", "down", "status", "send", "list", "doctor", "stats", "watch", "dash", "claim-port", "claim", "claims", "release", "rename", "wait"] as const;

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || !(COMMANDS as readonly string[]).includes(cmd)) {
    console.log(`patrol — standing-seat coordination for Claude Code

Usage:
  patrol up [config]     launch the fleet from patrol.yaml
  patrol down            tear the fleet down
  patrol status          fleet board: seats, roles, models, spend
  patrol send <handle> <msg>  message a seat (handle or id)
  patrol rename <h> <name>    rename a seat's handle
  patrol wait <h> --until done[,blocked] [--timeout 300]  block until a seat's state
  patrol list            list seats (compact)
  patrol doctor          check broker/daemon health
  patrol stats           telemetry: wake-ups, coalescing, attribution layers
  patrol watch           live TUI: fleet board + message log across projects
  patrol dash            open the command-center dashboard in your browser
  patrol claim-port <id> [n]     allocate n ports to a seat from the range
  patrol claim <id> <path>...    claim paths for a seat (advisory)
  patrol claims [git-root]       list current path claims
  patrol release <id> [path...]  release a seat's path claims`);
    return cmd ? 1 : 0;
  }
  const mod = await import(`./commands/${cmd}.ts`);
  return mod.default(args);
}

process.exit(await main());
