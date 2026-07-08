/**
 * SessionStart hook (plugin/hooks/reg-session.ts) unit tests: run the hook as
 * a subprocess with fixture stdin JSON against a stub HTTP server capturing
 * the POST. The hook is fire-and-forget — a dead broker must never break
 * session startup, so exit 0 is asserted on every path.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = new URL("../plugin/hooks/reg-session.ts", import.meta.url).pathname;
const PORT = 17901; // clear of the broker test port (17900)

const dir = mkdtempSync(join(tmpdir(), "patrol-hook-"));
const SECRET_FILE = join(dir, "secret");
writeFileSync(SECRET_FILE, "hook-test-secret", { mode: 0o600 });

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const STDIN_FIXTURE = JSON.stringify({
  session_id: "sess-hook-1",
  transcript_path: "/tmp/fake/transcript.jsonl",
  cwd: "/tmp/fake",
  hook_event_name: "SessionStart",
  source: "startup",
});

async function runHook(port: number): Promise<number> {
  const proc = Bun.spawn(["bun", HOOK], {
    env: {
      ...process.env,
      CLAUDE_PATROL_PORT: String(port),
      CLAUDE_PATROL_SECRET_FILE: SECRET_FILE,
    },
    stdin: new TextEncoder().encode(STDIN_FIXTURE),
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exited;
}

test("posts ObserveSessionRequest with auth header to /observe-session", async () => {
  let captured: { path: string; token: string | null; body: any } | null = null;
  const server = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      captured = {
        path: new URL(req.url).pathname,
        token: req.headers.get("x-patrol-token"),
        body: await req.json(),
      };
      return Response.json({ ok: true });
    },
  });
  try {
    const exit = await runHook(PORT);
    expect(exit).toBe(0);
    expect(captured).not.toBeNull();
    expect(captured!.path).toBe("/observe-session");
    expect(captured!.token).toBe("hook-test-secret");
    // exact frozen ObserveSessionRequest shape
    expect(Object.keys(captured!.body).sort()).toEqual(["claude_pid", "cwd", "session_id", "transcript_path"]);
    expect(captured!.body.session_id).toBe("sess-hook-1");
    expect(captured!.body.transcript_path).toBe("/tmp/fake/transcript.jsonl");
    expect(typeof captured!.body.cwd).toBe("string");
    expect(captured!.body.claude_pid).toBeGreaterThan(0);
  } finally {
    server.stop(true);
  }
});

test("exits 0 quietly when the broker is down", async () => {
  const exit = await runHook(PORT); // nothing listening now
  expect(exit).toBe(0);
});

test("exits 0 on malformed stdin (no POST attempted)", async () => {
  const proc = Bun.spawn(["bun", HOOK], {
    env: { ...process.env, CLAUDE_PATROL_PORT: String(PORT), CLAUDE_PATROL_SECRET_FILE: SECRET_FILE },
    stdin: new TextEncoder().encode("not json"),
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await proc.exited).toBe(0);
});
