/**
 * PreToolUse checkpoint guard (plugin/hooks/checkpoint-guard.ts) unit tests: run
 * the hook as a subprocess with fixture stdin and a lease file, and assert the
 * exact wire shape it prints. Every non-deny path is a FAIL-OPEN path — the hook
 * gates every mutating tool call in every seat, so a bug that denies (or throws)
 * where it shouldn't stops the whole fleet from working.
 */
import { test, expect, afterAll, describe } from "bun:test";
import { mkdtempSync, mkdirSync, chmodSync, existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEASE_FILE_ENV } from "../shared/types.ts";
import { checkGuardable } from "../src/seat-server.ts";

const HOOK = new URL("../plugin/hooks/checkpoint-guard.ts", import.meta.url).pathname;

const dir = mkdtempSync(join(tmpdir(), "patrol-guard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The worktree the seat is sitting in, and the one its leases name. The hook only denies
// when the lease covers this session's tree (v0.2.9.1), so both halves matter.
const SEAT_WT = "/work/wt";
const TOKEN = "cpl-" + "a".repeat(32);

function stdinFor(toolName: string, cwd = SEAT_WT): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    session_id: "sess-guard-1",
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: { file_path: `${cwd}/a.ts`, old_string: "a", new_string: "b" },
  }));
}

// A well-formed, live lease over the seat's own worktree — the shape that must deny.
function heldBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, token: TOKEN, expires_at: iso(60_000), path: SEAT_WT, ...overrides });
}

// The reason carries a live countdown, so assert its SHAPE and the load-bearing parts
// rather than a frozen string.
function expectDeny(stdout: string) {
  const out = JSON.parse(stdout).hookSpecificOutput;
  expect(out.hookEventName).toBe("PreToolUse");
  expect(out.permissionDecision).toBe("deny");
  return out.permissionDecisionReason as string;
}

async function runHook(
  leaseFile: string | null,
  opts: { tool?: string; cwd?: string } = {},
): Promise<{ exit: number; stdout: string }> {
  const env = { ...process.env } as Record<string, string>;
  delete env[LEASE_FILE_ENV];
  if (leaseFile !== null) env[LEASE_FILE_ENV] = leaseFile;
  const proc = Bun.spawn(["bun", HOOK], {
    env,
    stdin: stdinFor(opts.tool ?? "Edit", opts.cwd ?? SEAT_WT),
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
  // The hook is self-contained (no cross-dir import, like reg-session.ts) so it
  // survives packaging — which means its env name is a hardcoded COPY of
  // LEASE_FILE_ENV. On a drift the hook would watch a variable nobody sets: it
  // allows every call while the seat still reports itself guarded.
  test("the hook's hardcoded env name still matches the frozen LEASE_FILE_ENV", () => {
    expect(readFileSync(HOOK, "utf8")).toContain(`process.env.${LEASE_FILE_ENV}`);
  });

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
    const path = lease("held", heldBody());
    const { exit, stdout } = await runHook(path);
    expect(exit).toBe(0); // deny is carried by the JSON, never by the exit code
    expect(expectDeny(stdout)).toContain("patrol checkpoint");
  });

  // The matcher is "*", so a deny freezes the seat's READS too and a long gate can hold it
  // for minutes. An unactionable reason means the agent spins through retries for the whole
  // lease, which is the difference between a pause and an outage.
  test("the deny reason tells the agent HOW LONG to wait, as a floor not a deadline", async () => {
    const reason = expectDeny((await runHook(lease("countdown", heldBody({ expires_at: iso(95_000) })))).stdout);
    expect(reason).toMatch(/Wait at least ~9[0-9]s/); // the live countdown, not a constant
    expect(reason).toContain("reads included"); // says what is actually blocked
    expect(reason).toContain("retry");
    // The lease is RENEWED while the checkpoint runs, so the timestamp is a floor. A
    // "lifts by <time>" promise would be broken by the renewal and would send the agent
    // back to work mid-merge.
    expect(reason).toContain("extended while the checkpoint runs");
    expect(reason).not.toMatch(/at the latest|lifts by/);
  });

  // v0.2.9.1: the lease file carries a `version`. A file written by a NEWER checkpoint may
  // have moved these fields, so an unknown version must fail OPEN rather than guess.
  test("an unrecognized lease-file version allows (fail-open, never guess at moved fields)", async () => {
    for (const version of [2, 99, "1", null, undefined]) {
      const { exit, stdout } = await runHook(lease(`ver-${version}`, heldBody({ version })));
      expect({ version, exit, stdout }).toEqual({ version, exit: 0, stdout: "" });
    }
  });

  // v0.2.9.1: the matcher is "*", so the hook is asked about EVERY tool — including MCP
  // tools whose names it has never seen. Enumerating write-capable tool names is the
  // bypass class that let a full-profile seat's MCP file writer through while "leased".
  test("denies tools beyond the four built-ins, including MCP-style names", async () => {
    const path = lease("held-any-tool", heldBody());
    for (const tool of [
      "mcp__serena__replace_content",
      "mcp__serena__replace_symbol_body",
      "mcp__filesystem__write_file",
      "NotebookEdit",
      "Bash",
      "WebFetch",
      "SomeToolInventedNextQuarter",
    ]) {
      const { exit, stdout } = await runHook(path, { tool });
      expect({ tool, exit, denied: stdout !== "" }).toEqual({ tool, exit: 0, denied: true });
    }
  });

  test("past expiry -> allows (a checkpoint killed mid-run must not wedge the seat)", async () => {
    const path = lease("stale", heldBody({ expires_at: iso(-1000) }));
    const { exit, stdout } = await runHook(path);
    expect(exit).toBe(0);
    expect(stdout).toBe("");
  });

  // v0.2.9.1: a lease naming a DIFFERENT worktree must not freeze this seat. Lease files
  // are per-launch unique now, so a foreign one should never reach us — this is the second
  // lock on that door, and the one that makes a leftover file harmless.
  test("a lease over an unrelated worktree does NOT deny this seat", async () => {
    const path = lease("foreign-tree", heldBody({ path: "/some/other/fleet/wt" }));
    const { exit, stdout } = await runHook(path);
    expect(exit).toBe(0);
    expect(stdout).toBe("");
  });

  test("denies from a SUBDIRECTORY of the leased worktree, and from an ancestor of it", async () => {
    const path = lease("nested", heldBody());
    expect((await runHook(path, { cwd: `${SEAT_WT}/src/deep` })).stdout).not.toBe("");
    expect((await runHook(path, { cwd: "/work" })).stdout).not.toBe(""); // seat parked at the repo root
    // A sibling that merely shares a prefix is NOT inside it — the separator check matters.
    expect((await runHook(path, { cwd: "/work/wt-other" })).stdout).toBe("");
  });

  test("malformed / unparseable lease files -> allow (fail-open)", async () => {
    for (const [name, body] of [
      ["garbage", "not json at all"],
      ["empty", ""],
      ["no-expiry", JSON.stringify({ version: 1, token: TOKEN, path: SEAT_WT })],
      ["bad-date", heldBody({ expires_at: "whenever" })],
      ["wrong-type", heldBody({ expires_at: 12345 })],
      ["not-an-object", JSON.stringify(["expires_at"])],
      // v0.2.9.1 additions: a lease that can't say whose it is, or what it covers.
      ["no-token", JSON.stringify({ v: 1, expires_at: iso(60_000), path: SEAT_WT })],
      ["bad-token", heldBody({ token: "not-a-token" })],
      ["numeric-token", heldBody({ token: 12345 })],
      ["no-path", JSON.stringify({ version: 1, token: TOKEN, expires_at: iso(60_000) })],
      ["relative-path", heldBody({ path: "wt" })],
      ["root-path", heldBody({ path: "/" })],
      ["numeric-path", heldBody({ path: 7 })],
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

// --- v0.2.9.1: what `guarded` is allowed to claim ------------------------------
//
// Through v0.2.9 `guarded` was `LEASE_FILE_ENV !== null` — an env var certifying itself.
// `patrol checkpoint` refuses to run WITHOUT it and otherwise trusts it completely, so a
// relative path, a missing hook script, or an unwritable lease dir bought a checkpoint
// that merged behind a guard which could never deny anything (the hook fails open).
describe("checkGuardable (the seat's register-time guard claim)", () => {
  test("a writable dir + an absolute path + the hook on disk => guarded", () => {
    expect(checkGuardable(join(dir, "ok.lock"))).toBe(true);
  });

  test("creates a missing lease dir rather than failing the claim (clean install)", () => {
    const fresh = join(dir, "made-on-demand", "deep");
    expect(existsSync(fresh)).toBe(false);
    expect(checkGuardable(join(fresh, "s.lock"))).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });

  test("a RELATIVE lease path => NOT guarded (the hook reads it from an arbitrary cwd)", () => {
    expect(checkGuardable("leases/seat.lock")).toBe(false);
    expect(checkGuardable("./seat.lock")).toBe(false);
  });

  test("a lease dir that cannot be created => NOT guarded", () => {
    // Parent is a regular file: mkdir fails ENOTDIR, so checkpoint could never write here.
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    expect(checkGuardable(join(blocker, "seat.lock"))).toBe(false);
  });

  test("an unwritable lease dir => NOT guarded", () => {
    const locked = join(dir, "readonly-leases");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o500); // r-x: exists, but nothing can create the lease file
    try {
      expect(checkGuardable(join(locked, "seat.lock"))).toBe(false);
    } finally {
      chmodSync(locked, 0o700); // so afterAll can clean up
    }
  });

  // The honest limit, asserted as documentation: these checks say the hook is INSTALLABLE.
  // They cannot say Claude loaded the settings overlay, or will invoke the hook, or will
  // honour its deny — only the seat's own session knows that, and it has no way to tell us.
  // Closing it needs a seat-side ack handshake, which v0.2.9.1 deliberately does not build.
  test("guarded is a claim about installability, NOT proof the hook ever runs", () => {
    expect(readFileSync(new URL("../src/seat-server.ts", import.meta.url).pathname, "utf8"))
      .toContain("WHAT THIS STILL DOES NOT PROVE");
  });
});
