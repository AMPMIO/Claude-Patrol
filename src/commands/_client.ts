// W3-internal broker client + pure CLI helpers. Not a command (underscore →
// cli.ts never dispatches it). Auth contract (shared/auth.ts is W1's, absent
// here): secret at CLAUDE_PATROL_SECRET_FILE || ~/.claude-patrol.secret,
// header x-patrol-token; POST needs it, GET /health is open.
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
export { secretPermsOk } from "../../shared/auth.ts";

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

// A displayed seat identifier: its handle when it has one, else the short hex id.
export function seatLabel(seat: { handle?: string; id: string }): string {
  return seat.handle && seat.handle.length > 0 ? seat.handle : seat.id.slice(0, 8);
}

// Resolve a user-typed seat target (handle OR raw/prefix hex id) to a full seat id,
// CLIENT-SIDE, via /list-seats. Precedence — the handle is the primary UX identifier:
//   1. exact handle match           (readable name wins)
//   2. exact full id match           (raw hex id, unchanged — the fallback)
//   3. unique id-prefix match
// An ambiguous handle or prefix ERRORS with the candidates rather than routing to the
// wrong seat. Nothing matched throws too, so a typo never silently hits a live seat.
export async function resolveSeatTarget(target: string): Promise<string> {
  const seats = await brokerPost<Array<{ id: string; handle?: string; role: string | null }>>(
    "/list-seats",
    { scope: "machine", cwd: process.cwd(), git_root: gitRoot() }
  );
  const cand = (s: { id: string; role: string | null }) => `${s.id.slice(0, 8)}${s.role ? ` (${s.role})` : ""}`;

  const byHandle = seats.filter((s) => s.handle === target);
  if (byHandle.length === 1) return byHandle[0]!.id;
  if (byHandle.length > 1) throw new BrokerError(`ambiguous handle "${target}" — matches ${byHandle.map(cand).join(", ")}; use the id`);

  const exactId = seats.find((s) => s.id === target);
  if (exactId) return exactId.id;

  const byPrefix = seats.filter((s) => s.id.startsWith(target));
  if (byPrefix.length === 1) return byPrefix[0]!.id;
  if (byPrefix.length > 1) throw new BrokerError(`ambiguous id prefix "${target}" — matches ${byPrefix.map(cand).join(", ")}`);

  throw new BrokerError(`no live seat matches "${target}" — see \`patrol list\``);
}

// timeoutMs defaults to 3s (a wedged broker must not hang the CLI). A long-poll
// route like /wait-for passes a larger value — it legitimately holds the response
// open until the target reaches its state or the server-side timeout fires.
export async function brokerPost<T>(path: string, body: unknown, timeoutMs = 3000): Promise<T> {
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
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // network error OR AbortError (timeout) — both are "can't reach a working broker"
    throw new BrokerError(`broker unreachable at ${brokerBase()} — is it running? try: patrol doctor`);
  }
  if (!res.ok) {
    // The broker returns its real reason as JSON {error} (e.g. "to_id must be
    // an 8-char [a-z0-9] slug"); surface it instead of a bare "400 Bad Request".
    const detail = await res.json().then(
      (j) => (j && typeof j === "object" && "error" in j && typeof (j as { error: unknown }).error === "string"
        ? (j as { error: string }).error
        : ""),
      () => ""
    );
    throw new BrokerError(
      detail ? `broker ${path} failed (${res.status}): ${detail}` : `broker ${path} failed: ${res.status} ${res.statusText}`
    );
  }
  return (await res.json()) as T;
}

export async function brokerHealthy(): Promise<boolean> {
  try {
    const res = await fetch(brokerBase() + "/health", { signal: AbortSignal.timeout(3000) });
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
