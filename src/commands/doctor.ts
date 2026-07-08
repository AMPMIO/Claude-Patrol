// patrol doctor — environment + daemon health checks.
import type { Seat } from "../../shared/types.ts";
import { statSync } from "node:fs";
import {
  brokerBase,
  brokerHealthy,
  brokerPost,
  secretPath,
  secretPermsOk,
  parseClaudeHelp,
  pidAlive,
  BrokerError,
} from "./_client.ts";

type Level = "PASS" | "WARN" | "FAIL";
function line(level: Level, msg: string) {
  const tag = level === "PASS" ? "✓" : level === "WARN" ? "!" : "✗";
  console.log(`  ${tag} ${level.padEnd(4)} ${msg}`);
}

export default async function doctor(_args: string[]): Promise<number> {
  let failed = false;
  const fail = (m: string) => {
    failed = true;
    line("FAIL", m);
  };

  // 1. broker up
  const up = await brokerHealthy();
  if (up) line("PASS", `broker up at ${brokerBase()}`);
  else fail(`broker not responding at ${brokerBase()}/health — start it: patrol up`);

  // 2. secret file exists + 0600
  try {
    const st = statSync(secretPath());
    if (secretPermsOk(st.mode)) line("PASS", `secret ${secretPath()} (0600)`);
    else fail(`secret ${secretPath()} perms ${(st.mode & 0o777).toString(8)} too open — chmod 600 it`);
  } catch {
    fail(`secret file missing: ${secretPath()} (broker creates it on first start)`);
  }

  // 3. bun
  line("PASS", `bun ${Bun.version}`);

  // 4. tmux present
  if (Bun.which("tmux")) line("PASS", "tmux present");
  else line("WARN", "tmux not found — visible (tmux) seats unavailable; bg backend still works");

  // 5. claude launch flags
  const claude = Bun.which("claude");
  if (!claude) {
    line("WARN", "claude not on PATH — cannot verify --bg/--tmux support");
  } else {
    try {
      const proc = Bun.spawnSync([claude, "--help"]);
      const help = proc.stdout.toString() + proc.stderr.toString();
      const { bg, tmux } = parseClaudeHelp(help);
      if (bg && tmux) line("PASS", "claude supports --bg and --tmux");
      else {
        const missing = [!bg ? "--bg" : "", !tmux ? "--tmux" : ""].filter(Boolean).join(", ");
        line("WARN", `claude --help missing ${missing} — launcher backends may need adjusting`);
      }
    } catch {
      line("WARN", "could not run `claude --help`");
    }
  }

  // 6. legacy claude-peers broker on :7899
  try {
    const res = await fetch("http://127.0.0.1:7899/health", { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      line("WARN", "legacy claude-peers broker on :7899 — patrol uses :7900; they coexist, ensure seats target the right one");
    } else {
      line("PASS", "no legacy broker conflict on :7899");
    }
  } catch {
    line("PASS", "no legacy broker conflict on :7899");
  }

  // 7. stale seats (registered but PID dead)
  if (up) {
    try {
      const seats = await brokerPost<Seat[]>("/list-seats", { scope: "machine", cwd: process.cwd(), git_root: null });
      const stale = seats.filter((s) => !pidAlive(s.pid));
      if (stale.length === 0) line("PASS", `${seats.length} seat(s), none stale`);
      else {
        const ids = stale.map((s) => `${s.id.slice(0, 8)}(pid ${s.pid})`).join(", ");
        line("WARN", `stale seats (pid dead): ${ids} — broker purges on next sweep`);
      }
    } catch (e) {
      line("WARN", `could not list seats: ${e instanceof BrokerError ? e.message : String(e)}`);
    }
  }

  return failed ? 1 : 0;
}
