// patrol recall — give a returning seat POINTERS to its own prior sessions.
//
// Patrol's thesis is continuity: a seat that has worked a codebase for six waves
// beats one spawned thirty seconds ago. When that seat dies, its mail can be
// redelivered; its judgment cannot. The one piece only Patrol can supply is the
// MAPPING — seat_runs already binds seat -> session_id for cost attribution, and it
// OUTLIVES the seats row (endSeat sets ended_at, it does not delete the run). ctx
// (github.com/ctxrs/ctx) searches that history by content but has no concept of a
// seat, so it can never answer "what did `builder` decide last week".
//
// POINTERS ONLY — nothing here reads, embeds, or prints transcript CONTENT. Two
// reasons, both load-bearing:
//   1. a transcript pasted into a fresh agent's prompt is a token bomb, which defeats
//      the entire point of recalling rather than re-deriving;
//   2. ctx preserves secrets and local paths verbatim by design, so old transcript
//      text arriving inside a new seat's prompt is both a leak surface and a
//      prompt-injection vector — prior content would read as instructions.
// The seat decides what to open. This module only says where to look.
import { Database } from "bun:sqlite";
import { projectDirName } from "./costs.ts";

const DEFAULT_DB = `${process.env.HOME}/.claude-patrol.db`;

// ctx is OPTIONAL and is not installed on the dev machine this shipped from. Every
// path below must work without it, so this is a check, never a requirement.
export function ctxAvailable(): boolean {
  return Bun.which("ctx") !== null;
}

export interface PriorSession {
  session_id: string;
  cwd: string;
  role: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface PriorSessionsOptions {
  dbPath?: string;
  limit?: number;
}

// Prior runs for a seat NAME, newest first.
//
// The name->history join is not direct, and the indirection is worth stating: `handle`
// lives only on the live `seats` row and dies with it, while `seat_runs` keeps `role`.
// A launcher seat's role IS its patrol.yaml name (compose.ts: `role: seat.role ?? seat.name`),
// so role is the durable key. A live seat is also matched through its current handle, which
// covers a seat whose role was overridden to something else in the yaml.
//
// Runs that never bound a session_id are dropped: there is nothing to point AT, and
// listing them would read as "here is history" when it is the absence of history.
export function priorSessions(seatName: string, opts: PriorSessionsOptions = {}): PriorSession[] {
  const path = opts.dbPath ?? process.env.CLAUDE_PATROL_DB ?? DEFAULT_DB;
  let db: Database;
  try {
    // Read-only: `recall` must never be able to mutate fleet state, and a broker
    // holding the write lock must not be blocked by it.
    db = new Database(path, { readonly: true });
  } catch {
    return []; // no broker db yet == no history, not an error
  }
  try {
    const rows = db
      .query(
        `SELECT r.session_id, r.cwd, r.role, r.registered_at, r.ended_at
           FROM seat_runs r
           WHERE r.session_id IS NOT NULL
             AND (r.role = ?1 OR r.seat_id IN (SELECT id FROM seats WHERE handle = ?1))
           ORDER BY r.registered_at DESC`
      )
      .all(seatName) as { session_id: string; cwd: string; role: string | null; registered_at: string; ended_at: string | null }[];
    const limit = opts.limit ?? 20;
    return rows.slice(0, limit).map((r) => ({
      session_id: r.session_id,
      cwd: r.cwd,
      role: r.role,
      started_at: r.registered_at,
      ended_at: r.ended_at,
    }));
  } catch {
    // A db predating seat_runs (or any schema drift) degrades to "no history" rather
    // than crashing a command whose whole job is to be a helpful pointer.
    return [];
  } finally {
    db.close();
  }
}

// Where Claude Code writes a session's transcript. Same derivation the cost indexer
// uses, so this path is the one Patrol already reads elsewhere — not a guess.
export function transcriptPath(cwd: string, sessionId: string): string {
  return `~/.claude/projects/${projectDirName(cwd)}/${sessionId}.jsonl`;
}

// The text a returning seat is handed. Pure: no db, no PATH probe, no clock.
//
// EVERY ctx command below is quoted from ctx's own published docs. What is NOT
// documented anywhere I could find is a command that maps a PROVIDER session id (the
// Claude Code uuid Patrol holds) to a ctx session id: ctx's product contract states
// that "ctx show session and ctx locate session render transcripts... using ctx-owned
// IDs". So this never prints `ctx show session <patrol-session-id>` — that invocation
// would look right and fail. It prints the provider id, says plainly that ctx addresses
// sessions by its own id, and offers `ctx sql` (documented: "runs one read-only SQL
// statement against the existing local index") as the bridge, with the column name
// flagged as the part to discover rather than assumed.
export function recallBrief(seatName: string, sessions: PriorSession[], ctxPresent: boolean): string {
  const L: string[] = [];
  if (sessions.length === 0) {
    L.push(`seat "${seatName}": no prior sessions in this broker's history.`);
    L.push("");
    L.push("Nothing to recall. A run that never bound a session id leaves no pointer,");
    L.push("and a fleet that has only ever run under different seat names won't match here.");
    return L.join("\n");
  }

  const n = sessions.length;
  L.push(`seat "${seatName}": ${n} prior session${n === 1 ? "" : "s"}, newest first.`);
  L.push("");
  sessions.forEach((s, i) => {
    const ended = s.ended_at ?? "still open";
    L.push(`  ${i + 1}. ${s.session_id}`);
    L.push(`     ${s.started_at} -> ${ended}`);
    L.push(`     ${transcriptPath(s.cwd, s.session_id)}`);
  });
  L.push("");
  L.push("These are POINTERS. No transcript content was read, and none should be pasted");
  L.push("into a seat's prompt: it costs the tokens you are trying to save, and prior");
  L.push("text arriving inside a prompt reads as instructions.");
  L.push("");

  if (!ctxPresent) {
    L.push("`ctx` is not installed. It indexes local coding-agent history into SQLite and");
    L.push("makes these sessions searchable by content:  https://github.com/ctxrs/ctx");
    L.push("Without it, the .jsonl paths above are still readable by hand.");
    return L.join("\n");
  }

  L.push("`ctx` is installed. It addresses sessions by ITS OWN ids, and no documented");
  L.push("command maps a provider session id to a ctx one, so bridge it once:");
  L.push("");
  L.push(`  ctx sql "SELECT * FROM ctx_sessions LIMIT 1"`);
  L.push("      # find which column holds the provider's session id (schema not documented)");
  L.push(`  ctx sql "SELECT id FROM ctx_sessions WHERE <that column> = '${sessions[0]!.session_id}'"`);
  L.push("");
  L.push("then, with the ctx id it returns:");
  L.push("");
  L.push("  ctx show session <ctx-session-id>        # compact transcript");
  L.push("  ctx locate session <ctx-session-id>      # provenance + resume metadata");
  L.push("");
  L.push("Searching by content needs no mapping at all, and is usually the faster route:");
  L.push("");
  L.push(`  ctx search "<the decision you are trying to remember>"`);
  return L.join("\n");
}
