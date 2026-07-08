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
import { readdirSync, readFileSync } from "node:fs";
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

// Derive the ~/.claude/projects directory-name encoding for a working dir.
// CC replaces every non-alphanumeric run... actually each non-alnum char with
// a dash: /Users/me/Fable Hijack -> -Users-me-Fable-Hijack. Used to scope
// unattributed cost rows to the fleet's project dirs.
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}
