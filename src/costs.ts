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
import { PRICES, DEFAULT_PRICE, type BillingSource, type CostRow, type CostsResponse } from "../shared/types.ts";

const DEFAULT_PROJECTS_ROOT = `${process.env.HOME}/.claude/projects`;

// v0.2.4 billing_source: which WALLET a transcript's spend draws on, derived from
// the record's top-level `entrypoint` field (verified against real claude -p output:
// sdk-cli / sdk-py on Agent-SDK sessions, `cli` or absent on interactive ones). A
// codex seat has NO transcript, so its "external" pool is derived from the backend
// via the frozen billingSource(), never from here — this function only sees Claude
// transcripts and thus never returns "external". Unknown/absent => subscription,
// the safe default (mis-billing agent-sdk spend as a cheaper pool is worse than the
// reverse, and interactive is the overwhelming majority).
export function billingSourceFromEntrypoint(entrypoint: string | null | undefined): BillingSource {
  return typeof entrypoint === "string" && entrypoint.startsWith("sdk") ? "agent-sdk" : "subscription";
}

// $/MTok substring match, same precedence as token-audit.py (first key hit).
export function priceFor(model: string | null): [number, number, number, number] {
  for (const key of Object.keys(PRICES)) {
    if ((model ?? "").includes(key)) return PRICES[key]!;
  }
  return DEFAULT_PRICE;
}

// A path is included if it matches either the flat session log or a nested
// subagent transcript. Yields [absPath, projectDirName, parentSessionId] where
// parentSessionId is the <session> dir a subagents/ folder sits under (so its
// spend can roll up to the parent seat) and null for a flat session log. Pass
// projFilter to restrict the walk to specific project dirs (the broker's
// incremental indexer scopes to fleet-relevant dirs; undefined = all projects).
export function* sessionFiles(
  root: string,
  projFilter?: Set<string>
): Generator<[string, string, string | null]> {
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return; // no projects dir yet
  }
  for (const proj of projects) {
    if (projFilter && !projFilter.has(proj)) continue;
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
        yield [join(projDir, entry), proj, null];
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
        if (s.endsWith(".jsonl")) yield [join(subDir, s), proj, entry];
      }
    }
  }
}

// One assistant-usage record extracted from a jsonl line. The SINGLE source of
// truth for "what counts as billable usage": both computeCosts (the pure
// reference impl) and the broker's incremental indexer parse lines through
// here, so their token accounting can never drift.
export interface UsageDelta {
  sessionId: string;
  msgId: string | undefined; // absent id => never deduped (matches computeCosts)
  model: string;
  tsMs: number | null;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  entrypoint: string | null; // top-level record field; drives billing_source (v0.2.4)
}

// Parse ONE jsonl line to a UsageDelta, or null when the line is blank,
// malformed, non-assistant, or carries no usage block. Time-window filtering,
// dedupe, and attribution are the caller's job — this only decodes.
export function parseUsageLine(line: string): UsageDelta | null {
  if (!line) return null;
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (d.type !== "assistant") return null;
  const msg = d.message ?? {};
  const u = msg.usage;
  if (!u) return null;
  return {
    sessionId: d.sessionId ?? "?",
    msgId: msg.id,
    model: msg.model ?? "?",
    tsMs: d.timestamp ? Date.parse(d.timestamp) : null,
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cache_write: u.cache_creation_input_tokens ?? 0,
    cache_read: u.cache_read_input_tokens ?? 0,
    entrypoint: typeof d.entrypoint === "string" ? d.entrypoint : null,
  };
}

// --- v0.3 cache re-encode tax ("cache tax") ---------------------------------
//
// A prompt cache prefix expires after a few minutes without a request on it. When a
// seat then speaks again, its byte-identical append-only history is re-encoded at the
// cache-WRITE rate (1.25x input) instead of read back at 0.1x. A standing orchestrator
// blocked on a 20-minute worker is exactly the exposure, and nothing in the bill names
// it — the money shows up as ordinary cache_write.
//
// THIS IS A HEURISTIC OVER TRANSCRIPTS, NOT GROUND TRUTH. The logs record how many
// tokens took the write path; they do NOT record WHY. A large write that follows an
// established read looks the same whether the cache expired on an idle seat or the
// prefix genuinely changed — a model switch, a different tool set, a resumed session
// with different context, or a compaction all write a fresh prefix legitimately. Every
// one of those counts here. Read the number as "spend that took the write path after a
// prefix was already established", never as "money you lost". It is also not universal:
// on a configuration using the 1-hour cache TTL an idle seat mostly keeps its prefix,
// and the tax reads near zero. Understating is fine; overclaiming is not.
//
// The floor is what separates a real prefix re-encode from ordinary incremental writes
// (a turn's own new tokens are cached too, a few hundred to a few thousand at a time).
export const CACHE_REBUILD_FLOOR_TOKENS = 10_000;

// Classify ONE record against the session's history so far. `maxCacheReadSoFar` is the
// largest cache_read seen EARLIER in this session — the evidence that a prefix was
// established and being read back cheaply. Both halves are required: without (b) the
// first-time creation of a prefix (normal, not a tax) would count as a rebuild.
//
// Pure by construction: no files, no clock, no db. The caller threads the returned
// state into the next record, which is what makes this testable AND usable from the
// broker's incremental indexer, where a session's records arrive across many ticks.
export function classifyCacheRebuild(
  cacheWrite: number,
  cacheRead: number,
  maxCacheReadSoFar: number,
  floor: number = CACHE_REBUILD_FLOOR_TOKENS
): { rebuild: boolean; maxCacheRead: number } {
  // The current record's own read is folded in AFTER the decision: condition (b) is
  // about what the session showed EARLIER, not about this record.
  const rebuild = cacheWrite >= floor && maxCacheReadSoFar >= floor;
  return { rebuild, maxCacheRead: Math.max(maxCacheReadSoFar, cacheRead) };
}

// Whole-sequence convenience over the same rule, for a caller that holds a session's
// records in order (tests, and the full-walk computeCosts path).
export function classifyCacheRebuilds(
  records: { cache_write: number; cache_read: number }[],
  maxCacheReadSoFar = 0,
  floor: number = CACHE_REBUILD_FLOOR_TOKENS
): { rebuilds: number; rebuild_tokens: number; maxCacheRead: number } {
  let rebuilds = 0;
  let rebuild_tokens = 0;
  let max = maxCacheReadSoFar;
  for (const r of records) {
    const c = classifyCacheRebuild(r.cache_write, r.cache_read, max, floor);
    if (c.rebuild) {
      rebuilds += 1;
      rebuild_tokens += r.cache_write;
    }
    max = c.maxCacheRead;
  }
  return { rebuilds, rebuild_tokens, maxCacheRead: max };
}

interface Tally {
  session_id: string; // the record's OWN session (kept for display: subagent rows stay visible)
  attr_session_id: string; // parent for subagents, else own; drives seat_id lookup + scoping
  model: string;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  cache_rebuilds: number;
  cache_rebuild_tokens: number;
  billing_source: BillingSource; // from the record entrypoint; all records in a session share it
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
  // Rebuild detection is per SESSION (the prefix belongs to the session, not to one
  // model), while the counters land per (session, model) like every other tally. A
  // model switch mid-session therefore reads as a rebuild — that is the documented
  // false positive, not an oversight.
  const maxCacheRead = new Map<string, number>();

  for (const [file, proj, parentSessionId] of sessionFiles(root)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const rec = parseUsageLine(line);
      if (!rec) continue;
      if (rec.tsMs !== null) {
        if (since !== null && rec.tsMs < since) continue;
        if (until !== null && rec.tsMs > until) continue;
      }

      // A subagent record rolls up to its parent session for attribution and
      // scoping, but keeps its OWN session_id as the displayed row so the
      // per-model breakdown (e.g. a sonnet executor) stays visible.
      const ownSessionId = rec.sessionId;
      const attrSessionId = parentSessionId ?? ownSessionId;

      // Dedupe on (ownSessionId, msgId): resume rewrites re-emit prior lines,
      // and subagent msg ids are distinct from the parent's.
      const dedupeKey = `${ownSessionId}\0${rec.msgId}`;
      if (rec.msgId && seen.has(dedupeKey)) continue;
      if (rec.msgId) seen.add(dedupeKey);

      // project scoping: exact-attributed sessions always count; otherwise
      // include only if the seat fleet has a seat in this project dir.
      const attributed = seatSessions.has(attrSessionId);
      if (!attributed && opts.projects && !opts.projects.has(proj)) continue;

      const key = `${ownSessionId}\0${rec.model}`;
      let t = tally.get(key);
      if (!t) {
        t = { session_id: ownSessionId, attr_session_id: attrSessionId, model: rec.model, input: 0, output: 0, cache_write: 0, cache_read: 0, cache_rebuilds: 0, cache_rebuild_tokens: 0, billing_source: billingSourceFromEntrypoint(rec.entrypoint) };
        tally.set(key, t);
      }
      const cls = classifyCacheRebuild(rec.cache_write, rec.cache_read, maxCacheRead.get(ownSessionId) ?? 0);
      maxCacheRead.set(ownSessionId, cls.maxCacheRead);
      if (cls.rebuild) {
        t.cache_rebuilds += 1;
        t.cache_rebuild_tokens += rec.cache_write;
      }
      // L5: a session has ONE launch lineage, but `entrypoint` may be absent on
      // some records. Do NOT freeze billing_source from the first-seen line —
      // scan ALL of the session's records: if ANY carries an sdk* entrypoint the
      // session is agent-sdk. First-seen freezing would mis-bill agent-sdk spend
      // to the cheaper subscription wallet whenever an entrypoint-less line sorts
      // first (the "worse" direction).
      if (billingSourceFromEntrypoint(rec.entrypoint) === "agent-sdk") t.billing_source = "agent-sdk";
      t.input += rec.input;
      t.output += rec.output;
      t.cache_write += rec.cache_write;
      t.cache_read += rec.cache_read;
    }
  }

  const rows: CostRow[] = [];
  // Per-wallet running totals. These MUST stay separate — they bill different
  // accounts — so `patrol status` renders three columns, never one sum.
  const bySource: Partial<Record<BillingSource, number>> = {};
  let rebuilds = 0;
  let rebuildTokens = 0;
  let taxUsd = 0;
  for (const t of [...tally.values()].sort((a, b) => a.session_id.localeCompare(b.session_id))) {
    const [pi, po, pcw, pcr] = priceFor(t.model);
    const cost = (t.input * pi + t.output * po + t.cache_write * pcw + t.cache_read * pcr) / 1e6;
    bySource[t.billing_source] = (bySource[t.billing_source] ?? 0) + cost;
    rows.push({
      seat_id: seatSessions.get(t.attr_session_id) ?? null,
      session_id: t.session_id,
      model: t.model,
      input: t.input,
      output: t.output,
      cache_write: t.cache_write,
      cache_read: t.cache_read,
      cost_usd: Math.round(cost * 1e4) / 1e4,
      billing_source: t.billing_source,
      cache_rebuilds: t.cache_rebuilds,
      cache_rebuild_tokens: t.cache_rebuild_tokens,
    });
    rebuilds += t.cache_rebuilds;
    rebuildTokens += t.cache_rebuild_tokens;
    // Priced at THIS model's cache-write rate and summed — never an average across
    // models, whose rates differ by 5x between haiku and fable.
    taxUsd += (t.cache_rebuild_tokens * pcw) / 1e6;
  }
  // L4: round each wallet bucket, then derive total_usd as the SUM OF THE ROUNDED
  // buckets — so the displayed per-wallet columns always add up to the displayed
  // total. Rounding the grand total independently could leave a sub-cent gap, and
  // the whole point of the split is trustworthy per-wallet numbers.
  let roundedTotal = 0;
  for (const k of Object.keys(bySource) as BillingSource[]) {
    bySource[k] = Math.round(bySource[k]! * 1e4) / 1e4;
    roundedTotal += bySource[k]!;
  }
  return {
    rows,
    total_usd: Math.round(roundedTotal * 1e4) / 1e4,
    by_source: bySource,
    cache_tax: { rebuilds, rebuild_tokens: rebuildTokens, tax_usd: Math.round(taxUsd * 1e4) / 1e4 },
  };
}

// Incremental single-file parser for the broker's background indexer. Reads the
// byte range [fromByte, size) and returns the COMPLETE lines' usage records plus
// a cursor at the last newline consumed. A trailing segment past the last
// newline is left unconsumed so the next tick re-reads it whole — this defers
// a record still being flushed, and is safe because real CC logs terminate
// every record (including the last) with "\n" (verified), so a complete record
// is never stranded. This is why the cursor advances by bytes, not by parsed
// records. Truncation (size < fromByte) is the caller's to detect; it then
// passes fromByte=0.
// This runs INSIDE the broker process, synchronously, on the index tick. Allocating the
// whole unseen tail in one Buffer (what v0.2.2 did) means a large transcript stalls every
// broker HTTP request and heartbeat behind one giant allocation + parse. So read in bounded
// chunks and carry only the partial trailing line across them: peak memory is
// chunkBytes + at most maxRecordBytes, whatever the file's size.
export const TAIL_CHUNK_BYTES = 1 << 20; // 1 MiB per read
// A single JSONL record this large is not a real Claude Code entry; it is a corrupt or
// adversarial line. Cap it rather than growing the partial-line buffer without bound, and
// skip past it so the cursor still advances (otherwise it would jam the indexer forever).
export const TAIL_MAX_RECORD_BYTES = 8 << 20; // 8 MiB

const EMPTY = Buffer.alloc(0);

export function parseFileTail(
  file: string,
  fromByte: number,
  opts: { chunkBytes?: number; maxRecordBytes?: number } = {}
): { records: UsageDelta[]; bytesParsed: number; size: number } {
  const chunkBytes = Math.max(1, opts.chunkBytes ?? TAIL_CHUNK_BYTES);
  const maxRecordBytes = Math.max(1, opts.maxRecordBytes ?? TAIL_MAX_RECORD_BYTES);
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return { records: [], bytesParsed: fromByte, size: 0 };
  }
  const start = Math.min(Math.max(fromByte, 0), size);
  if (start >= size) return { records: [], bytesParsed: start, size };
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return { records: [], bytesParsed: start, size };
  }
  try {
    const records: UsageDelta[] = [];
    const chunk = Buffer.alloc(Math.min(chunkBytes, size - start));
    let pending = EMPTY; // bytes of the current line, still waiting for its newline
    let skipping = false; // the current line blew the cap; discard bytes until it ends
    // Cursor semantics are unchanged from v0.2.2: only COMPLETE lines are consumed, so
    // bytesParsed lands just past the last newline and a torn trailing write is re-read
    // next tick.
    let consumed = start;
    let pos = start;

    while (pos < size) {
      const want = Math.min(chunk.length, size - pos);
      const n = readSync(fd, chunk, 0, want, pos);
      if (n <= 0) break;
      const view = chunk.subarray(0, n);
      let off = 0;
      while (off < view.length) {
        const nl = view.indexOf(0x0a, off); // byte scan — never string length (UTF-8 multibyte)
        if (nl === -1) {
          const rest = view.subarray(off);
          if (skipping) {
            // still inside the oversize line: drop these bytes
          } else if (pending.length + rest.length > maxRecordBytes) {
            skipping = true;
            pending = EMPTY;
          } else {
            pending = pending.length ? Buffer.concat([pending, rest]) : Buffer.from(rest);
          }
          break; // need the next chunk to finish this line
        }
        if (skipping) {
          skipping = false; // the oversize line ends at this newline; it is discarded
          pending = EMPTY;
        } else {
          const seg = view.subarray(off, nl);
          const line = pending.length ? Buffer.concat([pending, seg]) : seg;
          pending = EMPTY;
          if (line.length <= maxRecordBytes) {
            const rec = parseUsageLine(line.toString("utf8"));
            if (rec) records.push(rec);
          }
        }
        consumed = pos + nl + 1; // byte offset just past this newline
        off = nl + 1;
      }
      pos += n;
    }
    // No complete line in the tail yet -> consumed is still `start`, matching v0.2.2.
    return { records, bytesParsed: consumed, size };
  } finally {
    closeSync(fd);
  }
}

// Layer 1 (PRIMARY) attribution: resolve a launcher-issued seat token to its
// session by content-matching the marker the launcher injected into the launch
// prompt. Substring scan over the seat's project-dir session logs (ANY record
// type — the spike showed the marker lands in user AND last-prompt/queue
// records), NOT mtime — this is what makes N seats in one cwd separable, the
// case the window heuristic collapses on. Returns the session id (the .jsonl
// filename stem) ONLY when EXACTLY one log contains the token: zero => not
// written yet (retry next tick), several => ambiguous (leave unbound). Scans
// only top-level logs; the marker rides the main prompt, not subagent files.
//
// scanCache (optional, caller-owned per run): filePath -> (size, mtimeMs) at
// which the file was read and found NOT to contain the token. On a re-scan an
// unchanged entry is skipped rather than re-read whole — this is what stops a
// never-landing token from re-reading a whole project dir on every index tick.
// New or changed files are always read; a match clears its entry. Correctness is
// unchanged: a skipped entry is a known non-match, so exactly-one-match-or-null
// still holds over the full current file set.
export function resolveTokenToSession(
  opts: { cwd: string; projectsRoot: string; token: string },
  scanCache?: Map<string, { size: number; mtimeMs: number }>
): string | null {
  const dir = join(opts.projectsRoot, projectDirName(opts.cwd));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null; // no project dir yet
  }
  const hits: string[] = [];
  for (const e of entries) {
    if (!e.endsWith(".jsonl")) continue;
    const full = join(dir, e);
    let st: { size: number; mtimeMs: number };
    try {
      st = statSync(full);
    } catch {
      continue; // vanished between readdir and stat
    }
    const cached = scanCache?.get(full);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) continue; // known miss, unchanged
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (text.includes(opts.token)) {
      hits.push(e.slice(0, -".jsonl".length));
      scanCache?.delete(full); // no longer a miss
    } else {
      scanCache?.set(full, { size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return hits.length === 1 ? hits[0]! : null;
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
