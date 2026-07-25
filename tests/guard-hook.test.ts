/**
 * PreToolUse checkpoint guard (plugin/hooks/checkpoint-guard.ts) unit tests: run
 * the hook as a subprocess with fixture stdin and a lease file, and assert the
 * exact wire shape it prints. Every non-deny path is a FAIL-OPEN path — the hook
 * gates every mutating tool call in every seat, so a bug that denies (or throws)
 * where it shouldn't stops the whole fleet from working.
 */
import { test, expect, afterAll, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEASE_FILE_ENV } from "../shared/types.ts";

const HOOK = new URL("../plugin/hooks/checkpoint-guard.ts", import.meta.url).pathname;

const dir = mkdtempSync(join(tmpdir(), "patrol-guard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const STDIN_FIXTURE = JSON.stringify({
  session_id: "sess-guard-1",
  cwd: "/tmp/fake",
  hook_event_name: "PreToolUse",
  tool_name: "Edit",
  tool_input: { file_path: "/tmp/fake/a.ts", old_string: "a", new_string: "b" },
});

const DENY = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      "patrol checkpoint in progress on this seat's worktree — hands off for a few seconds, then retry",
  },
};

async function runHook(leaseFile: string | null): Promise<{ exit: number; stdout: string }> {
  const env = { ...process.env } as Record<string, string>;
  delete env[LEASE_FILE_ENV];
  if (leaseFile !== null) env[LEASE_FILE_ENV] = leaseFile;
  const proc = Bun.spawn(["bun", HOOK], {
    env,
    stdin: new TextEncoder().encode(STDIN_FIXTURE),
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  return { exit: await proc.exited, stdout };
}

// Writes a lease file and returns its path. Each test gets its own file so a
// leftover lease can never leak into the next case.
function lease(name: string, body: string): string {
  const path = join(dir, `${name}.lock`);
  writeFileSync(path, body);
  return path;
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe("checkpoint guard hook", () => {
  test("no lease env -> allows (a seat with no lease path is unguarded, not blocked)", async () => {
    const { exit, stdout } = await runHook(null);
    expect(exit).toBe(0);
    expect(stdout).toBe("");
  });

  test("lease env set but file absent -> allows (the normal, unlocked steady state)", async () => {
    const { exit, stdout } = await runHook(join(dir, "does-not-exist.lock"));
    expect(exit).toBe(0);
    expect(stdout).toBe("");
  });

  test("future expiry -> denies with the exact PreToolUse wire shape", async () => {
    const path = lease("held", JSON.stringify({ expires_at: iso(60_000), path: "/work/wt" }));
    const { exit, stdout } = await runHook(path);
    expect(exit).toBe(0); // deny is carried by the JSON, never by the exit code
    expect(JSON.parse(stdout)).toEqual(DENY);
  });

  test("past expiry -> allows (a checkpoint killed mid-run must not wedge the seat)", async () => {
    const path = lease("stale", JSON.stringify({ expires_at: iso(-1000), path: "/work/wt" }));
    const { exit, stdout } = await runHook(path);
    expect(exit).toBe(0);
    expect(stdout).toBe("");
  });

  test("malformed / unparseable lease files -> allow (fail-open)", async () => {
    for (const [name, body] of [
      ["garbage", "not json at all"],
      ["empty", ""],
      ["no-expiry", JSON.stringify({ path: "/work/wt" })],
      ["bad-date", JSON.stringify({ expires_at: "whenever" })],
      ["wrong-type", JSON.stringify({ expires_at: 12345 })],
      ["not-an-object", JSON.stringify(["expires_at"])],
    ] as const) {
      const { exit, stdout } = await runHook(lease(name, body));
      expect({ name, exit, stdout }).toEqual({ name, exit: 0, stdout: "" });
    }
  });

  test("unreadable lease path (a directory) -> allows", async () => {
    const { exit, stdout } = await runHook(dir); // EISDIR on read
    expect(exit).toBe(0);
    expect(stdout).toBe("");
  });
});
