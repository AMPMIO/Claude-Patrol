import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildFirstTurnArgv,
  buildResumeTurnArgv,
  CodexThread,
  MAX_SEND_BYTES,
  spillPathFor,
  truncateForBroker,
  parseCodexJsonl,
  parseCodexSeatArgs,
  replyDestination,
  SerialTurnQueue,
  shouldRetireThread,
  type CodexSeatConfig,
} from "../src/codex-seat.ts";

const originalPath = process.env.PATH;
let fixtureDir = "";
let invocationLog = "";

const config = (retireTokens = 300_000): CodexSeatConfig => ({
  cwd: process.cwd(), role: "tester", model: "gpt-5.6-terra", effort: "medium",
  sandbox: "workspace-write", retireTokens, initialPrompt: "",
});

function fakeThread(retireTokens = 300_000): CodexThread {
  return new CodexThread(config(retireTokens), "codex", {
    PATH: `${fixtureDir}:${originalPath ?? ""}`,
    FAKE_CODEX_LOG: invocationLog,
  });
}

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "patrol-fake-codex-"));
  invocationLog = join(fixtureDir, "calls.log");
  writeFileSync(join(fixtureDir, "codex"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CODEX_LOG"
last=""
for value in "$@"; do last="$value"; done
if [ "$last" = "failinit" ]; then
  # A first turn that OPENS a thread and then fails: codex emitted thread.started (so the
  # id is adoptable) but the turn still exited nonzero. This is the adopt path.
  echo '{"type":"thread.started","thread_id":"fake-thread"}'
  echo '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":0,"reasoning_output_tokens":0}}'
  echo "fake codex init failure" >&2
  exit 7
fi
if [ "$last" = "fail" ]; then
  # A real turn can burn (and be billed for) its prefix and THEN fail, so emit usage
  # before exiting nonzero — that is the case the billing fix has to cover.
  # NOTE: no thread.started — a failed *resume* never emits one.
  echo '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":0,"reasoning_output_tokens":0}}'
  echo "fake codex failure" >&2
  exit 7
fi
case "$*" in
  *" resume "*) ;;
  *) echo '{"type":"thread.started","thread_id":"fake-thread"}' ;;
esac
echo "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"id\\":\\"item_0\\",\\"type\\":\\"agent_message\\",\\"text\\":\\"reply:$last\\"}}"
echo '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3,"reasoning_output_tokens":4}}'
`);
  chmodSync(join(fixtureDir, "codex"), 0o755);
  process.env.FAKE_CODEX_LOG = invocationLog;
  process.env.PATH = `${fixtureDir}:${originalPath ?? ""}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  delete process.env.FAKE_CODEX_LOG;
  rmSync(fixtureDir, { recursive: true, force: true });
});

test("parses the documented thread, reply, and structured usage events", () => {
  // Reply shape is the REAL codex-cli 0.144.0 one: agent_message nested inside item.completed.
  // (A flat top-level agent_message must still parse — asserted below — but nesting is what ships.)
  expect(parseCodexJsonl('{"type":"thread.started","thread_id":"t1"}\n{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"hello"}}\n{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":2,"output_tokens":3,"reasoning_output_tokens":4}}')).toEqual({
    threadId: "t1", reply: "hello", usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 4 },
  });
  // item.completed events that are NOT agent_message (e.g. codex's hook-config warning) are ignored.
  expect(parseCodexJsonl('{"type":"item.completed","item":{"id":"item_0","type":"error","message":"warn"}}').reply).toBe("");
  expect(parseCodexJsonl('{"type":"agent_message","text":"flat"}').reply).toBe("flat");
  expect(shouldRetireThread(11, 10)).toBe(true);
  expect(shouldRetireThread(10, 10)).toBe(false);
  expect(replyDestination("cli")).toBe("summary");
  expect(replyDestination("live-seat")).toBe("reply");
});

test("argv and environment configure the adapter without running Codex", () => {
  const parsed = parseCodexSeatArgs(["--cwd", "/repo", "--role", "reviewer", "--model", "gpt-test", "--effort", "high", "--sandbox", "read-only"], {
    CODEX_THREAD_RETIRE_BILLED_TOKENS: "42",
  });
  expect(parsed).toEqual({
    cwd: "/repo", role: "reviewer", model: "gpt-test", effort: "high", sandbox: "read-only", retireTokens: 42, initialPrompt: "",
  });
});

test("uses first-turn then resume command shapes and captures the thread id", async () => {
  const thread = fakeThread();
  const first = await thread.run("one");
  const second = await thread.run("two");
  expect(first).toMatchObject({ ok: true, threadId: "fake-thread", reply: "reply:one" });
  expect(second).toMatchObject({ ok: true, reply: "reply:two" });
  const calls = readFileSync(invocationLog, "utf8");
  expect(calls).toContain("exec --json --skip-git-repo-check");
  expect(calls).toContain("exec resume fake-thread --json --skip-git-repo-check");
  expect(buildFirstTurnArgv(config(), "p")).toEqual([
    "codex", "exec", "--json", "--skip-git-repo-check", "-m", "gpt-5.6-terra", "-c", 'model_reasoning_effort="medium"', "-s", "workspace-write", "--cd", process.cwd(), "p",
  ]);
  expect(buildResumeTurnArgv(config(), "t", "p")).toContain('sandbox_mode="workspace-write"');
});

test("serial queue preserves rapid turn order", async () => {
  const queue = new SerialTurnQueue();
  const thread = fakeThread();
  const replies: string[] = [];
  queue.enqueue(async () => { replies.push((await thread.run("first")).reply); });
  queue.enqueue(async () => { replies.push((await thread.run("second")).reply); });
  await queue.idle();
  expect(replies).toEqual(["reply:first", "reply:second"]);
});

test("retires after the threshold and starts the next turn fresh", async () => {
  const thread = fakeThread(5);
  await thread.run("before-retire");
  const next = await thread.run("after-retire");
  expect(next.threadId).toBe("fake-thread");
  const calls = readFileSync(invocationLog, "utf8");
  expect(calls).toContain("exec --json --skip-git-repo-check");
  expect(calls).toContain("continuing prior thread; summary: reply:before-retire");
});

test("a failed turn returns its error and the thread remains usable", async () => {
  const thread = fakeThread();
  const failed = await thread.run("fail");
  const recovered = await thread.run("works");
  expect(failed).toMatchObject({ ok: false, error: "fake codex failure" });
  expect(recovered).toMatchObject({ ok: true, reply: "reply:works" });
});

test("oversize replies are truncated under the broker cap and point at the spill path", () => {
  const path = spillPathFor("seat1234", 42);
  expect(path.endsWith(join(".claude-patrol", "replies", "seat1234", "42.txt"))).toBe(true);

  // Under the cap: delivered verbatim, nothing spilled.
  const small = truncateForBroker("short reply", path);
  expect(small).toEqual({ text: "short reply", spilled: false });

  // Over the cap: must fit (the broker hard-400s above MAX_SEND_BYTES) and name the path.
  const huge = "x".repeat(MAX_SEND_BYTES * 3);
  const cut = truncateForBroker(huge, path);
  expect(cut.spilled).toBe(true);
  expect(Buffer.byteLength(cut.text, "utf8")).toBeLessThanOrEqual(MAX_SEND_BYTES);
  expect(cut.text).toContain(`full reply: ${path}`);
  expect(cut.text.startsWith("xxxx")).toBe(true);

  // Multi-byte text must never be cut mid-codepoint (would corrupt the delivered reply).
  const multibyte = "é".repeat(MAX_SEND_BYTES);
  const cutMb = truncateForBroker(multibyte, path);
  expect(Buffer.byteLength(cutMb.text, "utf8")).toBeLessThanOrEqual(MAX_SEND_BYTES);
  expect(cutMb.text).not.toContain("�");

  // Astral chars are TWO UTF-16 units: a naive slice can strand a high surrogate, which
  // encodes as U+FFFD. Cut must drop the unpaired half instead of corrupting the reply.
  const emoji = "🙂".repeat(MAX_SEND_BYTES);
  const cutEmoji = truncateForBroker(emoji, path);
  expect(Buffer.byteLength(cutEmoji.text, "utf8")).toBeLessThanOrEqual(MAX_SEND_BYTES);
  expect(cutEmoji.text).not.toContain("�");
  expect(Buffer.from(cutEmoji.text, "utf8").toString("utf8")).toBe(cutEmoji.text); // round-trips clean

  // Contract holds even when the footer alone would blow the budget (absurd spill path).
  const longPath = "/x".repeat(4000);
  const tiny = truncateForBroker("y".repeat(100), longPath, 64);
  expect(Buffer.byteLength(tiny.text, "utf8")).toBeLessThanOrEqual(64);
});

test("a failed turn is still billed toward retirement", async () => {
  // The prefix was sent and charged even though the turn errored — not billing it would
  // let the re-sent-prefix tax grow unbounded across a run of failures.
  // Fixture bills 12 (10 input + 2 cached) per turn. Threshold 20 means ONE success alone
  // (12) must NOT retire, but success + failed turn (24) MUST — so this passes only if the
  // failed turn is counted.
  writeFileSync(invocationLog, "");
  const thread = fakeThread(20);
  await thread.run("one"); // success: billed 12, opens the thread
  const failed = await thread.run("fail"); // errors, but its usage was emitted and billed -> 24
  expect(failed.ok).toBe(false);
  await thread.run("next"); // 24 > 20 -> retire, so this turn carries a handoff
  expect(readFileSync(invocationLog, "utf8")).toContain("continuing prior thread; summary:");
});

test("a failed first turn adopts the thread it opened, and two consecutive failures abandon it", async () => {
  // (a) ADOPT: a first turn that opened a thread then failed must still be resumed — we are
  //     already being billed for that thread; starting fresh would orphan it.
  // (b) ESCAPE HATCH: but a permanently-broken adopted thread must not wedge the seat. A
  //     failed resume emits no thread.started (id never changes), so without a failure
  //     counter every later message would hit the same dead thread forever.
  writeFileSync(invocationLog, "");
  const thread = fakeThread();

  const first = await thread.run("failinit"); // opens fake-thread, then fails
  expect(first).toMatchObject({ ok: false, threadId: "fake-thread" });

  const second = await thread.run("fail"); // must RESUME the adopted id -> proves (a)
  expect(second.ok).toBe(false);

  const third = await thread.run("works"); // 2 consecutive failures cleared it -> fresh
  expect(third).toMatchObject({ ok: true, reply: "reply:works" });

  const calls = readFileSync(invocationLog, "utf8").trim().split("\n");
  expect(calls).toHaveLength(3);
  expect(calls[1]).toContain("exec resume fake-thread"); // (a) the adopted id was resumed
  expect(calls[2]).not.toContain("resume"); // (b) turn 3 started a FRESH thread
  expect(calls[2]).toContain("exec --json");
});

test("a single failure does not discard an otherwise good thread", async () => {
  // The counter is 2, not 1: one transient blip must not throw away a working thread.
  writeFileSync(invocationLog, "");
  const thread = fakeThread();
  await thread.run("one"); // success -> thread open
  await thread.run("fail"); // one failure only
  await thread.run("two"); // must still RESUME, not start fresh
  const calls = readFileSync(invocationLog, "utf8").trim().split("\n");
  expect(calls[2]).toContain("exec resume fake-thread");
});

test("thread-less failures do not abandon the next thread on arrival", async () => {
  // Regression: a failure with no thread open still incremented consecutiveFailures (the
  // abandon guard needs a threadId, so it never fired to reset it). After two such
  // failures the counter sat at 2, so the NEXT turn that actually opened a thread adopted
  // it and abandoned it in the same breath — orphaning a thread we are billed for, which
  // is precisely what the adopt exists to prevent. Adopting a new id resets the count.
  writeFileSync(invocationLog, "");
  const thread = fakeThread();
  await thread.run("fail"); // thread-less failure (no thread.started)
  await thread.run("fail"); // thread-less failure -> naive counter would now be 2
  const opened = await thread.run("failinit"); // opens fake-thread, then fails
  expect(opened).toMatchObject({ ok: false, threadId: "fake-thread" });

  await thread.run("works"); // must RESUME the adopted thread, not start fresh
  const calls = readFileSync(invocationLog, "utf8").trim().split("\n");
  expect(calls).toHaveLength(4);
  expect(calls[3]).toContain("exec resume fake-thread");
  expect(calls[3]).not.toContain("--cd"); // resume shape, i.e. genuinely not a fresh exec
});
