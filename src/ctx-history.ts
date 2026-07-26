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
import { detectFleet } from "./launcher/fleet-detect.ts";

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
  fleet?: string | null; // null = every fleet; omitted = the fleet of cwd
}

// Why a result type rather than a bare array: "this seat has no history" and "I could
// not read the history at all" are different answers, and collapsing them makes recall
// tell a confident lie about a corrupt or missing db. `unavailable` carries the reason
// so the command can exit on a different code and say what actually happened.
export type PriorSessionsResult =
  | { ok: true; sessions: PriorSession[] }
  | { ok: false; reason: string };

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
export function priorSessions(seatName: string, opts: PriorSessionsOptions = {}): PriorSessionsResult {
  const path = opts.dbPath ?? process.env.CLAUDE_PATROL_DB ?? DEFAULT_DB;
  let db: Database;
  try {
    // Read-only: `recall` must never be able to mutate fleet state, and a broker
    // holding the write lock must not be blocked by it.
    db = new Database(path, { readonly: true });
  } catch (e) {
    return { ok: false, reason: `cannot open the broker db at ${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    // v0.3 added `fleet` and `stable_key` to seat_runs. A db written by an older
    // broker has neither, so the column list decides the query rather than a version
    // guess — and an old db still answers, just without fleet scoping.
    const cols = new Set((db.query("PRAGMA table_info(seat_runs)").all() as { name: string }[]).map((c) => c.name));
    if (cols.size === 0) return { ok: false, reason: `${path} has no seat_runs table — not a Patrol broker db, or one written before v0.2` };
    const hasFleet = cols.has("fleet");
    const hasStableKey = cols.has("stable_key");

    // Fleet scoping is the difference between "builder's history" and "every builder
    // on this machine's history". Two fleets each running a `builder` is the normal
    // v0.3 case, and merging them would hand a seat someone else's decisions. An
    // explicit `fleet: null` opts out; a NULL fleet column (pre-0.3 row) always
    // matches, because scoping it out would silently hide all legacy history.
    const fleet = opts.fleet === null ? null : (opts.fleet ?? detectFleetSafe());
    const fleetClause = hasFleet && fleet !== null ? "AND (r.fleet = ?2 OR r.fleet IS NULL)" : "";

    // stable_key is v0.3's durable seat identity, literally `<fleet>/<seatName>`
    // (compose.ts stableKey()) and the key the broker itself adopts on. Matching it
    // finds a seat whose yaml overrode `role:` to something other than its name, which
    // the role/handle join alone cannot do once the seat is dead. With a known fleet
    // the match is exact; without one it falls back to any fleet's seat of that name,
    // which is the widest this may ever go.
    const keyClause = !hasStableKey
      ? ""
      : fleet !== null
        ? "OR r.stable_key = ?2 || '/' || ?1"
        : "OR r.stable_key LIKE '%/' || ?1";

    const rows = db
      .query(
        `SELECT r.session_id, r.cwd, r.role, r.registered_at, r.ended_at
           FROM seat_runs r
           WHERE r.session_id IS NOT NULL
             ${fleetClause}
             AND (r.role = ?1 OR r.seat_id IN (SELECT id FROM seats WHERE handle = ?1) ${keyClause})
           ORDER BY r.registered_at DESC`
      )
      // ?2 is referenced by either clause independently (an old db can have stable_key
      // without fleet), so the binding follows the SQL, not one of the two flags.
      .all(...(fleetClause || keyClause.includes("?2") ? [seatName, fleet!] : [seatName])) as {
      session_id: string; cwd: string; role: string | null; registered_at: string; ended_at: string | null;
    }[];

    const limit = opts.limit ?? 20;
    return {
      ok: true,
      sessions: rows.slice(0, limit).map((r) => ({
        session_id: r.session_id,
        cwd: r.cwd,
        role: r.role,
        started_at: r.registered_at,
        ended_at: r.ended_at,
      })),
    };
  } catch (e) {
    return { ok: false, reason: `cannot read ${path}: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    db.close();
  }
}

// `patrol recall` must answer from any directory, including one with a broken
// patrol.yaml. detectFleet already ignores an unparseable config, but a thrown error
// here would turn a scoping DEFAULT into a hard failure, so it degrades to unscoped.
function detectFleetSafe(): string | null {
  try {
    return detectFleet();
  } catch {
    return null;
  }
}

// Where Claude Code writes a session's transcript. Same derivation the cost indexer
// uses, so this path is the one Patrol already reads elsewhere — not a guess.
//
// The id is shape-checked first because the broker only length-checks it
// (`isOptStr(b.session_id, 256)`), never its characters. A seat registering
// `../../../.ssh/id_rsa` as its session id would otherwise have Patrol print a path
// pointing outside the projects tree, which reads as if Patrol found it there.
export function transcriptPath(cwd: string, sessionId: string): string | null {
  if (!SAFE_IN_COMMAND.test(sessionId)) return null;
  return `~/.claude/projects/${projectDirName(cwd)}/${sessionId}.jsonl`;
}

// The text a returning seat is handed. Pure: no db, no PATH probe, no clock.
//
// EVERY ctx command below is quoted from ctx's own published docs, and the bridging
// SQL is checked against ctx's source rather than guessed. No CLI command maps a
// PROVIDER session id (the Claude Code uuid Patrol holds) to a ctx session id: ctx's
// product contract states that "ctx show session and ctx locate session render
// transcripts... using ctx-owned IDs". So this never prints
// `ctx show session <patrol-session-id>` — that invocation would look right and fail.
//
// The bridge is `ctx sql` ("runs one read-only SQL statement against the existing
// local index"). Its column names are NOT guessed: the `ctx_sessions` view is defined
// in crates/ctx-history-store/src/schema/views.rs as
//   SELECT s.id AS ctx_session_id, ..., s.external_session_id AS provider_session_id
// so the view exposes `ctx_session_id` and `provider_session_id` and has no `id`
// column at all. An earlier draft of this file emitted `SELECT id`, which would have
// failed with "no such column" — exactly the self-consistent-but-wrong shape this
// project has been bitten by before.
//
// The emitted `ctx sql` line is a string a human is told to PASTE INTO A SHELL, which
// makes it the one place here where an untrusted value becomes executable. Neither
// value that could land in it is trustworthy: the broker length-checks session_id
// (`isOptStr(b.session_id, 256)`) but never checks its CHARACTERS, so a seat can
// register `"; rm -rf ~ #` as its session id, and a seat name is whatever the yaml
// said. So both are shape-gated below and replaced by a placeholder when they fail —
// the id is still printed, on its own line, where it is data and not an argument.
const SAFE_IN_COMMAND = /^[A-Za-z0-9._-]{1,64}$/;

// Display sanitizer for values that are only ever printed as prose. Control
// characters (an ANSI escape, a CR that rewrites the line) would otherwise let a
// crafted seat name or session id forge output that looks like Patrol's own.
function display(s: string, max = 128): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, "?").slice(0, max);
}

export function recallBrief(seatName: string, sessions: PriorSession[], ctxPresent: boolean): string {
  const L: string[] = [];
  const name = display(seatName, 64);
  if (sessions.length === 0) {
    L.push(`seat "${name}": no prior sessions in this broker's history.`);
    L.push("");
    L.push("Nothing to recall. A run that never bound a session id leaves no pointer,");
    L.push("and a fleet that has only ever run under different seat names won't match here.");
    return L.join("\n");
  }

  const n = sessions.length;
  L.push(`seat "${name}": ${n} prior session${n === 1 ? "" : "s"}, newest first.`);
  L.push("");
  sessions.forEach((s, i) => {
    const ended = display(s.ended_at ?? "still open", 40);
    // Every value below comes out of the db and is therefore attacker-influenced;
    // display() strips the control characters that would let one forge a line.
    L.push(`  ${i + 1}. ${display(s.session_id, 80)}`);
    L.push(`     ${display(s.started_at, 40)} -> ${ended}`);
    const p = transcriptPath(s.cwd, s.session_id);
    L.push(p === null ? "     (no transcript path: this session id is not a plain identifier)" : `     ${p}`);
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

  L.push("`ctx` is installed. Its show/locate commands take ctx's OWN session ids, not");
  L.push("the provider ids above, and no CLI command maps between them — so bridge with");
  L.push("SQL, which is read-only and documented:");
  L.push("");
  const first = sessions[0]!.session_id;
  const idArg = SAFE_IN_COMMAND.test(first) ? first : "<session-id-from-the-list-above>";
  L.push(`  ctx sql "SELECT ctx_session_id FROM ctx_sessions WHERE provider_session_id = '${idArg}'"`);
  if (idArg !== first) {
    // Refusing to interpolate is the point: this line is meant to be pasted into a
    // shell, and the id is not a value Patrol validates.
    L.push("      # that id is not a plain identifier, so it is NOT pasted into the command");
  }
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
