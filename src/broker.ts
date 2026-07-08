#!/usr/bin/env bun
/**
 * claude-patrol broker daemon
 *
 * Singleton HTTP server on localhost:7900 backed by SQLite. Tracks registered
 * seats and routes messages between them. Ported from claude-peers-mcp
 * (feat/coalesce-metadata-auth): auth header, sender-context join on poll,
 * additive migrations, delivered-purge, stale-PID cleanup. Patrol additions:
 * profile + session_id columns and a /costs endpoint (per-seat spend).
 *
 * Auto-launched by the seat server if not already running. Run directly:
 *   bun src/broker.ts
 */
import { Database } from "bun:sqlite";
import { getSecret, TOKEN_HEADER } from "../shared/auth.ts";
import { computeCosts, projectDirName } from "./costs.ts";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListSeatsRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  UnregisterRequest,
  CostsRequest,
  CostsResponse,
  Seat,
} from "../shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PATROL_PORT ?? "7900", 10);
const DB_PATH = process.env.CLAUDE_PATROL_DB ?? `${process.env.HOME}/.claude-patrol.db`;
const PROJECTS_ROOT = process.env.CLAUDE_PATROL_PROJECTS_ROOT; // undefined -> costs.ts default
const BROKER_START = new Date().toISOString();

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS seats (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    role TEXT,
    model TEXT,
    profile TEXT,
    session_id TEXT,
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

// Additive migrations for DBs created before a column existed. Each ALTER is
// idempotent-by-try: it throws (and is ignored) once the column is present.
for (const col of ["role TEXT", "model TEXT", "profile TEXT", "session_id TEXT"]) {
  try {
    db.run(`ALTER TABLE seats ADD COLUMN ${col}`);
  } catch {
    // column already exists
  }
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  )
`);

// Clean up seats whose PID is gone; cap delivered-message table growth.
function cleanStaleSeats() {
  const seats = db.query("SELECT id, pid FROM seats").all() as { id: string; pid: number }[];
  for (const seat of seats) {
    try {
      process.kill(seat.pid, 0); // signal 0 = liveness probe, doesn't kill
    } catch {
      db.run("DELETE FROM seats WHERE id = ?", [seat.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [seat.id]);
    }
  }
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  db.run("DELETE FROM messages WHERE delivered = 1 AND sent_at < ?", [cutoff]);
}

cleanStaleSeats();
setInterval(cleanStaleSeats, 30_000);

// --- Prepared statements ---

const insertSeat = db.prepare(`
  INSERT INTO seats (id, pid, cwd, git_root, tty, summary, role, model, profile, session_id, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateLastSeen = db.prepare(`UPDATE seats SET last_seen = ? WHERE id = ?`);
const updateSummary = db.prepare(`UPDATE seats SET summary = ? WHERE id = ?`);
const deleteSeat = db.prepare(`DELETE FROM seats WHERE id = ?`);
const selectAllSeats = db.prepare(`SELECT * FROM seats`);
const selectSeatsByDirectory = db.prepare(`SELECT * FROM seats WHERE cwd = ?`);
const selectSeatsByGitRoot = db.prepare(`SELECT * FROM seats WHERE git_root = ?`);
const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?, ?, ?, ?, 0)
`);
const selectUndelivered = db.prepare(`
  SELECT m.id, m.from_id, m.to_id, m.text, m.sent_at, m.delivered,
         s.summary AS from_summary, s.cwd AS from_cwd,
         s.role AS from_role, s.model AS from_model
  FROM messages m LEFT JOIN seats s ON s.id = m.from_id
  WHERE m.to_id = ? AND m.delivered = 0
  ORDER BY m.sent_at ASC
`);
const markDelivered = db.prepare(`UPDATE messages SET delivered = 1 WHERE id = ?`);

// --- Seat ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// --- Handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();
  // Re-registration for the same PID replaces the prior row.
  const existing = db.query("SELECT id FROM seats WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) deleteSeat.run(existing.id);
  insertSeat.run(
    id, body.pid, body.cwd, body.git_root, body.tty, body.summary,
    body.role ?? null, body.model ?? null, body.profile ?? null, body.session_id ?? null,
    now, now
  );
  return { id };
}

function handleListSeats(body: ListSeatsRequest): Seat[] {
  let seats: Seat[];
  switch (body.scope) {
    case "directory":
      seats = selectSeatsByDirectory.all(body.cwd) as Seat[];
      break;
    case "repo":
      seats = body.git_root
        ? (selectSeatsByGitRoot.all(body.git_root) as Seat[])
        : (selectSeatsByDirectory.all(body.cwd) as Seat[]);
      break;
    case "machine":
    default:
      seats = selectAllSeats.all() as Seat[];
  }
  if (body.exclude_id) seats = seats.filter((s) => s.id !== body.exclude_id);
  // Drop seats whose process has died since last cleanup tick.
  return seats.filter((s) => {
    try {
      process.kill(s.pid, 0);
      return true;
    } catch {
      deleteSeat.run(s.id);
      return false;
    }
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  const target = db.query("SELECT id FROM seats WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) return { ok: false, error: `Seat ${body.to_id} not found` };
  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const rows = selectUndelivered.all(body.id) as PollMessagesResponse["messages"];
  for (const m of rows) markDelivered.run(m.id);
  // These rows were undelivered at SELECT and are delivered by this response;
  // report delivered=true (the DB int is 0 until markDelivered above runs).
  return { messages: rows.map((m) => ({ ...m, delivered: true })) };
}

// Idempotent dereg: by explicit id (seat-server shutdown) or by pid (SessionEnd
// hook, which knows only its $PPID). A no-match is not an error — the hook may
// fire after stale-PID cleanup already removed the row.
function handleUnregister(body: UnregisterRequest): void {
  let id = body.id;
  if (!id && body.pid != null) {
    const row = db.query("SELECT id FROM seats WHERE pid = ?").get(body.pid) as { id: string } | null;
    id = row?.id;
  }
  if (id) {
    deleteSeat.run(id);
    db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [id]);
  }
}

function handleCosts(body: CostsRequest): CostsResponse {
  const seats = selectAllSeats.all() as (Seat & { session_id: string | null })[];
  const seatSessions = new Map<string, string>();
  const projects = new Set<string>();
  for (const s of seats) {
    if (s.session_id) seatSessions.set(s.session_id, s.id);
    projects.add(projectDirName(s.cwd));
  }
  return computeCosts({
    projectsRoot: PROJECTS_ROOT,
    since: body.since ?? BROKER_START,
    until: body.until,
    seatSessions,
    projects,
  });
}

// --- HTTP server ---

const SECRET = getSecret();

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", seats: (selectAllSeats.all() as Seat[]).length });
      }
      return new Response("claude-patrol broker", { status: 200 });
    }

    if (req.headers.get(TOKEN_HEADER) !== SECRET) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    try {
      const body = await req.json();
      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          updateLastSeen.run(new Date().toISOString(), (body as HeartbeatRequest).id);
          return Response.json({ ok: true });
        case "/set-summary":
          updateSummary.run((body as SetSummaryRequest).summary, (body as SetSummaryRequest).id);
          return Response.json({ ok: true });
        case "/list-seats":
          return Response.json(handleListSeats(body as ListSeatsRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/costs":
          return Response.json(handleCosts(body as CostsRequest));
        case "/unregister":
          handleUnregister(body as UnregisterRequest);
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  },
});

console.error(`[claude-patrol broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
