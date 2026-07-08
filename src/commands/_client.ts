// W3-internal broker client + pure CLI helpers. Not a command (underscore →
// cli.ts never dispatches it). Auth contract (shared/auth.ts is W1's, absent
// here): secret at CLAUDE_PATROL_SECRET_FILE || ~/.claude-patrol.secret,
// header x-patrol-token; POST needs it, GET /health is open.
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

export function brokerBase(): string {
  const port = process.env.CLAUDE_PATROL_PORT || "7900";
  return `http://127.0.0.1:${port}`;
}

export function secretPath(): string {
  return process.env.CLAUDE_PATROL_SECRET_FILE || join(homedir(), ".claude-patrol.secret");
}

export async function readToken(): Promise<string | null> {
  try {
    const t = (await Bun.file(secretPath()).text()).trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

export class BrokerError extends Error {}

export async function brokerPost<T>(path: string, body: unknown): Promise<T> {
  const token = await readToken();
  if (!token) {
    throw new BrokerError(`no patrol secret at ${secretPath()} — is the broker running? try: patrol up`);
  }
  let res: Response;
  try {
    res = await fetch(brokerBase() + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-patrol-token": token },
      body: JSON.stringify(body),
    });
  } catch {
    throw new BrokerError(`broker unreachable at ${brokerBase()} — is it running? try: patrol doctor`);
  }
  if (!res.ok) {
    throw new BrokerError(`broker ${path} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function brokerHealthy(): Promise<boolean> {
  try {
    const res = await fetch(brokerBase() + "/health");
    return res.ok;
  } catch {
    return false;
  }
}

// nearest ancestor holding a .git entry (dir OR file — worktrees use a file)
export function gitRoot(start: string = process.cwd()): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---- pure helpers (unit-tested; no I/O) ----

export function relTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "?";
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…";
}

export function usd(n: number): string {
  return "$" + n.toFixed(2);
}

export function renderTable(headers: string[], rows: string[][], rightAlign: Set<number> = new Set()): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const pad = (cell: string, i: number) => {
    const w = widths[i] ?? 0;
    return rightAlign.has(i) ? cell.padStart(w) : cell.padEnd(w);
  };
  const fmt = (cells: string[]) => cells.map(pad).join("  ").trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join("\n");
}

// 0600 exactly: owner rw, no group/other bits (file-type bits in mode ignored)
export function secretPermsOk(mode: number): boolean {
  return (mode & 0o077) === 0 && (mode & 0o600) === 0o600;
}

export function parseClaudeHelp(help: string): { bg: boolean; tmux: boolean } {
  return { bg: /--bg\b/.test(help), tmux: /--tmux\b/.test(help) };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = gone; EPERM = exists but not ours (still alive)
    return (e as { code?: string }).code === "EPERM";
  }
}
