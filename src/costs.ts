/**
 * Per-seat cost tracking — Patrol's differentiator (DESIGN #1).
 *
 * TypeScript port of Fable Hijack benchmarks/token-audit.py. The load-bearing
 * correctness detail: subagent transcripts live in
 *   <project>/<session>/subagents/agent-*.jsonl
 * and omitting them undercounted subagent-topology runs by ~63%. Both globs
 * below MUST stay. Dedupe on (sessionId, message id) because session resumes
 * rewrite prior assistant lines.
 */
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { PRICES, DEFAULT_PRICE, type CostRow, type CostsResponse } from "../shared/types.ts";

const DEFAULT_PROJECTS_ROOT = `${process.env.HOME}/.claude/projects`;

// $/MTok substring match, same precedence as token-audit.py (first key hit).
export function priceFor(model: string | null): [number, number, number, number] {
  for (const key of Object.keys(PRICES)) {
    if ((model ?? "").includes(key)) return PRICES[key]!;
  }
  return DEFAULT_PRICE;
}

// A path is included if it matches either the flat session log or a nested
// subagent transcript. Returns [absPath, projectDirName] pairs.
function* sessionFiles(root: string): Generator<[string, string]> {
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return; // no projects dir yet
  }
  for (const proj of projects) {
    const projDir = join(root, proj);
    let entries: string[];
    try {
      entries = readdirSync(projDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      // flat: <root>/<proj>/<session>.jsonl
      if (entry.endsWith(".jsonl")) {
        yield [join(projDir, entry), proj];
        continue;
      }
      // nested: <root>/<proj>/<session>/subagents/agent-*.jsonl
      const subDir = join(projDir, entry, "subagents");
      let subs: string[];
      try {
        subs = readdirSync(subDir);
      } catch {
        continue; // not a session dir with subagents
      }
      for (const s of subs) {
        if (s.endsWith(".jsonl")) yield [join(subDir, s), proj];
      }
    }
  }
}

interface Tally {
  session_id: string;
  model: string;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

export interface ComputeCostsOptions {
  projectsRoot?: string;
  since?: string; // ISO lower bound (inclusive)
  until?: string; // ISO upper bound (inclusive)
  seatSessions?: Map<string, string>; // sessionId -> seatId (exact attribution)
  projects?: Set<string>; // project-dir names to include unattributed rows from; undefined = all
}

export function computeCosts(opts: ComputeCostsOptions = {}): CostsResponse {
  const root = opts.projectsRoot ?? DEFAULT_PROJECTS_ROOT;
  const since = opts.since ? Date.parse(opts.since) : null;
  const until = opts.until ? Date.parse(opts.until) : null;
  const seatSessions = opts.seatSessions ?? new Map();

  const tally = new Map<string, Tally>(); // key: sessionId\0model
  const seen = new Set<string>(); // (sessionId, message id) — resume-rewrite guard

  for (const [file, proj] of sessionFiles(root)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d.type !== "assistant") continue;
      const ts = d.timestamp ? Date.parse(d.timestamp) : null;
      if (ts !== null) {
        if (since !== null && ts < since) continue;
        if (until !== null && ts > until) continue;
      }
      const msg = d.message ?? {};
      const u = msg.usage;
      if (!u) continue;

      const sessionId: string = d.sessionId ?? "?";
      const msgId = msg.id;
      const dedupeKey = `${sessionId}\0${msgId}`;
      if (msgId && seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // project scoping: exact-attributed sessions always count; otherwise
      // include only if the seat fleet has a seat in this project dir.
      const attributed = seatSessions.has(sessionId);
      if (!attributed && opts.projects && !opts.projects.has(proj)) continue;

      const model: string = msg.model ?? "?";
      const key = `${sessionId}\0${model}`;
      let t = tally.get(key);
      if (!t) {
        t = { session_id: sessionId, model, input: 0, output: 0, cache_write: 0, cache_read: 0 };
        tally.set(key, t);
      }
      t.input += u.input_tokens ?? 0;
      t.output += u.output_tokens ?? 0;
      t.cache_write += u.cache_creation_input_tokens ?? 0;
      t.cache_read += u.cache_read_input_tokens ?? 0;
    }
  }

  const rows: CostRow[] = [];
  let total = 0;
  for (const t of [...tally.values()].sort((a, b) => a.session_id.localeCompare(b.session_id))) {
    const [pi, po, pcw, pcr] = priceFor(t.model);
    const cost = (t.input * pi + t.output * po + t.cache_write * pcw + t.cache_read * pcr) / 1e6;
    total += cost;
    rows.push({
      seat_id: seatSessions.get(t.session_id) ?? null,
      session_id: t.session_id,
      model: t.model,
      input: t.input,
      output: t.output,
      cache_write: t.cache_write,
      cache_read: t.cache_read,
      cost_usd: Math.round(cost * 1e4) / 1e4,
    });
  }
  return { rows, total_usd: Math.round(total * 1e4) / 1e4 };
}

// Best-effort seat -> session-id mapping at register time. Looks in the seat's
// project dir for a session log touched within windowMs. Returns the id ONLY
// when exactly one candidate is fresh: zero or several must degrade to null,
// because a WRONG per-seat cost attribution is worse than an absent one (two
// seats in the same cwd racing is exactly the several-candidates case).
export function findSessionIdByHeuristic(opts: {
  cwd: string;
  projectsRoot: string;
  nowMs: number;
  windowMs?: number;
}): string | null {
  const window = opts.windowMs ?? 120_000;
  const dir = join(opts.projectsRoot, projectDirName(opts.cwd));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null; // no project dir yet
  }
  const fresh: string[] = [];
  for (const e of entries) {
    if (!e.endsWith(".jsonl")) continue;
    try {
      if (opts.nowMs - statSync(join(dir, e)).mtimeMs <= window) fresh.push(e);
    } catch {
      // vanished between readdir and stat — ignore
    }
  }
  if (fresh.length !== 1) return null;
  return fresh[0]!.slice(0, -".jsonl".length);
}

// Read the first record timestamp (ms) from a session log, scanning only a
// bounded prefix so a large active transcript isn't loaded whole. Null if no
// timestamped record is found in the prefix.
function firstTimestampMs(file: string): number | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString("utf8", 0, n).split("\n")) {
      if (!line) continue;
      try {
        const d = JSON.parse(line);
        if (d.timestamp) return Date.parse(d.timestamp);
      } catch {
        // truncated tail line of the prefix — stop scanning further
        break;
      }
    }
  } finally {
    closeSync(fd);
  }
  return null;
}

// Query-time attribution. The register-time mtime heuristic races log creation:
// the MCP server registers during session init, but CC writes the session's
// .jsonl seconds later (around the first message), so a normally-booted seat
// registers with session_id null. By /costs time the file exists, so we anchor
// on the log's FIRST record timestamp being within windowMs of the seat's
// registered_at. Same never-misattribute rules: exactly-one-or-null per seat,
// and a session claimed by more than one seat is dropped (cross-seat unique).
export function attributeSeatsToSessions(opts: {
  seats: Array<{ id: string; cwd: string; session_id: string | null; registered_at: string }>;
  projectsRoot: string;
  windowMs?: number;
}): Map<string, string> {
  const window = opts.windowMs ?? 120_000;
  const claims: Array<{ seatId: string; sessionId: string }> = [];

  for (const seat of opts.seats) {
    if (seat.session_id) {
      // register-time / env-override fast path (already uniqueness-guarded)
      claims.push({ seatId: seat.id, sessionId: seat.session_id });
      continue;
    }
    const registeredAt = Date.parse(seat.registered_at);
    if (Number.isNaN(registeredAt)) continue;
    const dir = join(opts.projectsRoot, projectDirName(seat.cwd));
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    const hits: string[] = [];
    for (const e of entries) {
      if (!e.endsWith(".jsonl")) continue;
      const ts = firstTimestampMs(join(dir, e));
      if (ts !== null && Math.abs(ts - registeredAt) <= window) hits.push(e);
    }
    if (hits.length === 1) claims.push({ seatId: seat.id, sessionId: hits[0]!.slice(0, -".jsonl".length) });
  }

  // cross-seat uniqueness: a session claimed by >1 seat degrades to unattributed
  const counts = new Map<string, number>();
  for (const c of claims) counts.set(c.sessionId, (counts.get(c.sessionId) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const c of claims) if (counts.get(c.sessionId) === 1) out.set(c.sessionId, c.seatId);
  return out;
}

// Derive the ~/.claude/projects directory-name encoding for a working dir: CC
// replaces each non-alphanumeric char with a dash, so /Users/me/.claude ->
// -Users-me--claude (the /. becomes --). Verified against real project dirs on
// this machine. Used only to scope UNATTRIBUTED cost rows to the fleet's
// projects — if CC's encoding ever diverges, that scoping silently drops those
// rows (exact-attributed rows are unaffected).
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}
