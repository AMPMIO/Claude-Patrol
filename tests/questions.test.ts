/**
 * v0.2.5 question inbox + dashboard route. Spins a real broker on an alternate
 * port with a temp DB + secret, then exercises /ask, /questions, /answer (incl.
 * the answer landing back at the asking seat via /poll-messages), the dead-seat
 * reap of open questions, and GET /dashboard (token injection + marker).
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 17901;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "patrol-questions-"));
const SECRET_FILE = join(dir, "secret");
const DB_FILE = join(dir, "test.db");
const PROJECTS_ROOT = join(dir, "projects");

let broker: ReturnType<typeof Bun.spawn>;
let TOKEN: string;

async function post(path: string, body: unknown, token = TOKEN) {
  return fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-patrol-token": token },
    body: JSON.stringify(body),
  });
}

// Register a live seat (this test process's pid is live) and return its id.
async function registerSeat(fields: Record<string, unknown> = {}): Promise<string> {
  const res = await post("/register", {
    pid: process.pid,
    cwd: "/tmp/q-seat",
    git_root: null,
    tty: null,
    summary: "asker",
    role: null,
    model: null,
    ...fields,
  });
  return ((await res.json()) as { id: string }).id;
}

type Question = {
  id: number;
  from_id: string;
  from_handle: string | null;
  text: string;
  asked_at: string;
  answered: boolean;
  answer: string | null;
  answered_at: string | null;
};

async function questions(open_only: boolean | undefined = undefined): Promise<Question[]> {
  const res = await post("/questions", open_only === undefined ? {} : { open_only });
  return (await res.json()) as Question[];
}

beforeAll(async () => {
  broker = Bun.spawn(["bun", new URL("../src/broker.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      CLAUDE_PATROL_PORT: String(PORT),
      CLAUDE_PATROL_DB: DB_FILE,
      CLAUDE_PATROL_SECRET_FILE: SECRET_FILE,
      CLAUDE_PATROL_PROJECTS_ROOT: PROJECTS_ROOT,
      CLAUDE_PATROL_INDEX_INTERVAL_MS: "80",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${URL_BASE}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  TOKEN = (await Bun.file(SECRET_FILE).text()).trim();
});

afterAll(() => {
  broker.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("/ask inserts a question and returns its id; /questions lists it open", async () => {
  const seat = await registerSeat({ role: "builder", model: "opus", name: "builder-q1" });

  const askRes = await post("/ask", { id: seat, text: "gate ALL removes or only recursive ones?" });
  expect(askRes.status).toBe(200);
  const ask = (await askRes.json()) as { ok: boolean; question_id: number };
  expect(ask.ok).toBe(true);
  expect(typeof ask.question_id).toBe("number");

  const open = await questions(true);
  const mine = open.find((q) => q.id === ask.question_id)!;
  expect(mine).toBeDefined();
  expect(mine.from_id).toBe(seat);
  expect(mine.from_handle).toBe("builder-q1"); // resolved from the seat row at ask time
  expect(mine.answered).toBe(false);
  expect(mine.text).toBe("gate ALL removes or only recursive ones?");
});

test("/answer marks the question answered, drops it from the open list, and delivers a message to the asking seat", async () => {
  const seat = await registerSeat({ name: "answer-target" });
  const ask = (await (await post("/ask", { id: seat, text: "confirm N=3 retry cap?" })).json()) as { question_id: number };

  const ans = await post("/answer", { question_id: ask.question_id, text: "yes, N=3 and CC the orchestrator" });
  expect(ans.status).toBe(200);
  expect(((await ans.json()) as { ok: boolean }).ok).toBe(true);

  // no longer open, but present in the full list, answered, with answered_at set
  expect((await questions(true)).some((q) => q.id === ask.question_id)).toBe(false);
  const closed = (await questions(false)).find((q) => q.id === ask.question_id)!;
  expect(closed.answered).toBe(true);
  expect(closed.answer).toBe("yes, N=3 and CC the orchestrator");
  expect(closed.answered_at).not.toBeNull();

  // The load-bearing assertion: the answer reaches the asking seat via the SAME
  // path /poll-messages sees, from the reserved sender id "human".
  const poll = await post("/poll-messages", { id: seat });
  const { messages } = (await poll.json()) as { messages: Array<{ from_id: string; text: string }> };
  const human = messages.find((m) => m.from_id === "human");
  expect(human).toBeDefined();
  expect(human!.text).toBe("yes, N=3 and CC the orchestrator");
});

test("double-answer is harmless — the second answer is a no-op, not a second delivery", async () => {
  const seat = await registerSeat();
  const ask = (await (await post("/ask", { id: seat, text: "double?" })).json()) as { question_id: number };

  expect((await post("/answer", { question_id: ask.question_id, text: "first" })).status).toBe(200);
  const second = await post("/answer", { question_id: ask.question_id, text: "second" });
  expect(second.status).toBe(200);
  expect(((await second.json()) as { ok: boolean }).ok).toBe(true); // idempotent ok

  // Exactly ONE human message was enqueued (the first answer); the second did not resend.
  const poll = await post("/poll-messages", { id: seat });
  const { messages } = (await poll.json()) as { messages: Array<{ from_id: string; text: string }> };
  const humans = messages.filter((m) => m.from_id === "human");
  expect(humans).toHaveLength(1);
  expect(humans[0]!.text).toBe("first"); // first answer wins
});

test("/ask by an unknown seat is handled cleanly; malformed input is rejected 400", async () => {
  // well-formed slug, but no live seat under it → app-level {ok:false}, not a crash
  const unknown = await post("/ask", { id: "zzzzzzzz", text: "who am I asking for" });
  expect(unknown.status).toBe(200);
  expect(((await unknown.json()) as { ok: boolean }).ok).toBe(false);

  // malformed id and empty text are validation errors
  expect((await post("/ask", { id: "bad", text: "x" })).status).toBe(400);
  const seat = await registerSeat();
  expect((await post("/ask", { id: seat, text: "" })).status).toBe(400);

  // answering a nonexistent question is clean, not a crash
  const noq = await post("/answer", { question_id: 999999, text: "into the void" });
  expect(noq.status).toBe(200);
  expect(((await noq.json()) as { ok: boolean }).ok).toBe(false);
});

test("a dead seat's OPEN questions are reaped; ANSWERED history survives", async () => {
  // Register LIVE (own pid) so /ask succeeds — a seat cannot ask once dead. Death
  // is then simulated by /unregister, which runs endSeat (the same reap path a
  // real dead-pid sweep hits).
  const reg = await post("/register", { pid: process.pid, cwd: "/tmp/q-dead", git_root: null, tty: null, summary: "dying", role: "ghost", model: null });
  const dead = ((await reg.json()) as { id: string }).id;

  // one open, one answered — both belong to the soon-to-be-reaped seat
  const openQ = (await (await post("/ask", { id: dead, text: "open when I die" })).json()) as { question_id: number };
  const ansQ = (await (await post("/ask", { id: dead, text: "answered before I die" })).json()) as { question_id: number };
  await post("/answer", { question_id: ansQ.question_id, text: "here you go" });

  // seat leaves → endSeat reaps its OPEN questions, keeps answered history
  await post("/unregister", { id: dead });

  const all = await questions(false);
  expect(all.some((q) => q.id === openQ.question_id)).toBe(false); // open one reaped
  const survived = all.find((q) => q.id === ansQ.question_id)!;
  expect(survived).toBeDefined(); // answered history survives the seat
  expect(survived.answered).toBe(true);
  expect(survived.answer).toBe("here you go");
});

test("GET /dashboard returns 200 text/html with a marker and the injected token", async () => {
  const res = await fetch(`${URL_BASE}/dashboard`); // no token — open like /health
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const html = await res.text();
  expect(html).toContain("Patrol Command Center"); // page marker
  expect(html).toContain(TOKEN); // secret injected for the page's POSTs
  expect(html).not.toContain("__PATROL_TOKEN__"); // placeholder was replaced
});
