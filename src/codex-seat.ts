#!/usr/bin/env bun
/**
 * Codex patrol-seat adapter. It is intentionally a normal broker seat without
 * a seat_token or session_id: Codex CLI spend is unattributed in v0.2.2 because
 * it has no Claude Code transcript for the broker's attribution pipeline.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSecret, TOKEN_HEADER } from "../shared/auth.ts";
import type {
  DeliveredMessage,
  PollMessagesResponse,
  RegisterResponse,
  SeatId,
} from "../shared/types.ts";

const BROKER_PORT = parseInt(process.env.CLAUDE_PATROL_PORT ?? "7900", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const TURN_TIMEOUT_MS = 10 * 60_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

export interface CodexSeatConfig {
  cwd: string;
  role: string;
  model: string;
  effort: string;
  sandbox: string;
  retireTokens: number;
  initialPrompt: string;
}

export interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export interface ParsedCodexEvents {
  threadId: string | null;
  reply: string;
  usage: CodexUsage | null;
}

export interface CodexTurnResult extends ParsedCodexEvents {
  ok: boolean;
  error: string | null;
}

function log(msg: string) {
  console.error(`[claude-patrol codex] ${msg}`);
}

export function parseCodexSeatArgs(args: string[], env: NodeJS.ProcessEnv = process.env): CodexSeatConfig {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${flag ?? ""}`);
    const key = flag.slice(2);
    if (!["cwd", "role", "model", "effort", "sandbox", "prompt"].includes(key)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    values[key] = value;
  }
  const parsedRetire = Number(env.CODEX_THREAD_RETIRE_BILLED_TOKENS ?? "300000");
  return {
    cwd: values.cwd ?? env.CLAUDE_PATROL_CWD ?? process.cwd(),
    role: values.role ?? env.CLAUDE_PATROL_ROLE ?? "codex",
    model: values.model ?? env.CLAUDE_PATROL_MODEL ?? "gpt-5.6-terra",
    effort: values.effort ?? env.CODEX_REASONING_EFFORT ?? "medium",
    sandbox: values.sandbox ?? env.CODEX_SANDBOX_MODE ?? "workspace-write",
    retireTokens: Number.isFinite(parsedRetire) && parsedRetire >= 0 ? parsedRetire : 300000,
    initialPrompt: values.prompt ?? env.CLAUDE_PATROL_PROMPT ?? "",
  };
}

export function buildFirstTurnArgv(config: Pick<CodexSeatConfig, "cwd" | "model" | "effort" | "sandbox">, prompt: string): string[] {
  return [
    "codex", "exec", "--json", "--skip-git-repo-check", "-m", config.model,
    "-c", `model_reasoning_effort=${JSON.stringify(config.effort)}`,
    "-s", config.sandbox, "--cd", config.cwd, prompt,
  ];
}

export function buildResumeTurnArgv(
  config: Pick<CodexSeatConfig, "model" | "effort" | "sandbox">,
  threadId: string,
  prompt: string
): string[] {
  return [
    "codex", "exec", "resume", threadId, "--json", "--skip-git-repo-check", "-m", config.model,
    "-c", `model_reasoning_effort=${JSON.stringify(config.effort)}`,
    "-c", `sandbox_mode=${JSON.stringify(config.sandbox)}`, prompt,
  ];
}

/** Parse only the documented JSONL events; unrelated progress events are ignored. */
export function parseCodexJsonl(output: string): ParsedCodexEvents {
  let threadId: string | null = null;
  const replies: string[] = [];
  let usage: CodexUsage | null = null;
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    if (record.type === "thread.started" && typeof record.thread_id === "string") threadId = record.thread_id;
    // The reply arrives NESTED, as {"type":"item.completed","item":{"type":"agent_message","text":…}}
    // — verified against codex-cli 0.144.0. The flat {"type":"agent_message"} form is accepted too so a
    // CLI that emits the item directly still parses.
    if (record.type === "item.completed" && record.item && typeof record.item === "object") {
      const item = record.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") replies.push(item.text);
    }
    if (record.type === "agent_message" && typeof record.text === "string") replies.push(record.text);
    if (record.type === "turn.completed" && record.usage && typeof record.usage === "object") {
      const raw = record.usage as Record<string, unknown>;
      if (typeof raw.input_tokens === "number") {
        usage = {
          input_tokens: raw.input_tokens,
          cached_input_tokens: typeof raw.cached_input_tokens === "number" ? raw.cached_input_tokens : 0,
          output_tokens: typeof raw.output_tokens === "number" ? raw.output_tokens : 0,
          reasoning_output_tokens: typeof raw.reasoning_output_tokens === "number" ? raw.reasoning_output_tokens : 0,
        };
      }
    }
  }
  return { threadId, reply: replies.join("\n"), usage };
}

// Retirement happens before the next turn, once billed input has crossed the limit.
// The budget is CUMULATIVE BILLED TOKENS: a cost proxy, not live context size. Retiring
// exists to stop the growing re-sent-prefix tax, and billed input IS that tax — so the
// running SUM (not the last turn's context) is the right quantity, and cached input
// counts because it is still billed.
export function shouldRetireThread(billedTokens: number, retireBilledTokens: number): boolean {
  return billedTokens > retireBilledTokens;
}

// Mirrors the broker's MAX_TEXT_BYTES (src/broker.ts) — a send above it is a hard 400.
// Codex routinely returns more than this for code, and an oversize reply would be
// silently dropped, so long replies are truncated and the full text spilled to disk.
// Truncation is right even ignoring the cap: a 100KB dump inside a channel wake bills
// the receiver's whole context, whereas a path lets them opt in with a Read.
export const MAX_SEND_BYTES = 8 * 1024;

export function spillPathFor(seatId: string, messageId: number): string {
  return join(homedir(), ".claude-patrol", "replies", seatId, `${messageId}.txt`);
}

export interface DeliverableReply {
  text: string;
  spilled: boolean;
}

/**
 * Longest prefix of `text` that fits in `maxBytes` of UTF-8, cut on a codepoint
 * boundary. `.slice()` indexes UTF-16 code UNITS, so a naive cut can leave a
 * trailing unpaired high surrogate (an astral char like an emoji is two units) —
 * that encodes as U+FFFD and corrupts the delivered reply, so it is dropped.
 */
function byteClamp(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let kept = text;
  while (Buffer.byteLength(kept, "utf8") > maxBytes) {
    const over = Buffer.byteLength(kept, "utf8") - maxBytes;
    kept = kept.slice(0, Math.max(0, kept.length - Math.max(1, Math.ceil(over / 4))));
  }
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1); // unpaired high surrogate
  return kept;
}

/** Fit `text` under the broker cap, pointing at `spillPath` when it had to be cut. */
export function truncateForBroker(text: string, spillPath: string, limit = MAX_SEND_BYTES): DeliverableReply {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= limit) return { text, spilled: false };
  // Size the footer with the largest N it could print (total), so the real footer is
  // never longer than the budget we reserved for it.
  const footerFor = (n: number) => `\n…[truncated ${n} bytes; full reply: ${spillPath}]`;
  const budget = limit - Buffer.byteLength(footerFor(total), "utf8");
  if (budget <= 0) {
    // A spill path long enough to eat the whole budget still must not exceed the cap —
    // the function's contract is "always fits", independent of the caller.
    const footer = footerFor(total).trimStart();
    return { text: byteClamp(footer, limit), spilled: true };
  }
  // Cut on a character boundary, never mid-codepoint.
  let kept = byteClamp(text, budget);
  return { text: kept + footerFor(total - Buffer.byteLength(kept, "utf8")), spilled: true };
}

/** Write the untruncated reply beside the db/secret so the receiver can Read it. */
function spillReply(seatId: string, messageId: number, text: string): string {
  const path = spillPathFor(seatId, messageId);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

export function replyDestination(fromId: string): "reply" | "summary" {
  // The broker accepts only a live seat id or "cli" as senders; it cannot
  // accept an outbound reply addressed to "cli" because cli is not a seat.
  return fromId === "cli" ? "summary" : "reply";
}

// The retirement handoff is prepended inside CodexThread.run (it owns thread state), so
// this builds only the per-message prompt.
export function buildTurnPrompt(config: Pick<CodexSeatConfig, "role" | "initialPrompt">, message: DeliveredMessage): string {
  const briefing = config.initialPrompt ? `\n\nSeat briefing:\n${config.initialPrompt}` : "";
  return `You are patrol seat ${config.role}. Reply directly and usefully to this message from ${message.from_id}.${briefing}\n\n${message.text}`;
}

// A deliberately tiny FIFO used by the daemon and tests. Codex itself permits
// concurrent turns, but a patrol seat must preserve one coherent thread.
export class SerialTurnQueue {
  private tail = Promise.resolve();
  private pending = 0;

  enqueue(task: () => Promise<void>): void {
    this.pending++;
    this.tail = this.tail
      .then(task)
      .catch((error: unknown) => {
        log(`Turn error: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.pending--;
      });
  }

  /** Backpressure signal: true while any turn is queued or running. */
  busy(): boolean {
    return this.pending > 0;
  }

  async idle(): Promise<void> {
    await this.tail;
  }
}

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [TOKEN_HEADER]: getSecret() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) throw new Error(`Broker error (${path}): ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    return (await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) return;
  log("Starting broker daemon...");
  const proc = Bun.spawn(["sh", "-c", 'nohup bun "$1" >/dev/null 2>&1 &', "sh", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  proc.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

function getTty(): string | null {
  try {
    const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(process.pid)]);
    const tty = new TextDecoder().decode(proc.stdout).trim();
    return tty && tty !== "?" && tty !== "??" ? tty : null;
  } catch {
    return null;
  }
}

export class CodexThread {
  private threadId: string | null = null;
  private billedTokens = 0;
  private lastReply = "";

  // executable is injectable only for tests; production always uses "codex".
  constructor(
    private readonly config: CodexSeatConfig,
    private readonly executable = "codex",
    private readonly env: Record<string, string> | undefined = undefined
  ) {}

  async run(prompt: string): Promise<CodexTurnResult> {
    let handoff: string | null = null;
    if (this.threadId && shouldRetireThread(this.billedTokens, this.config.retireTokens)) {
      handoff = `continuing prior thread; summary: ${this.lastReply.slice(0, 500).replace(/\s+/g, " ")}`;
      log(`Retiring Codex thread ${this.threadId} after ${this.billedTokens} billed tokens`);
      this.threadId = null;
      this.billedTokens = 0;
    }
    const effectivePrompt = handoff ? `${handoff}\n\n${prompt}` : prompt;
    const argv = this.threadId
      ? buildResumeTurnArgv(this.config, this.threadId, effectivePrompt)
      : buildFirstTurnArgv(this.config, effectivePrompt);
    argv[0] = this.executable;
    let proc: {
      exited: Promise<number>;
      stdout: ReadableStream<Uint8Array>;
      stderr: ReadableStream<Uint8Array>;
      kill: () => void;
    };
    try {
      proc = Bun.spawn(argv, {
        cwd: this.config.cwd,
        stdin: "ignore", // Codex reads stdin; keeping it open makes a turn hang.
        stdout: "pipe",
        stderr: "pipe",
        env: this.env,
      });
    } catch (error) {
      return {
        threadId: null,
        reply: "",
        usage: null,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const stdout = new Response(proc.stdout).text();
    const stderr = new Response(proc.stderr).text();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, TURN_TIMEOUT_MS);
    const exitCode = await proc.exited;
    clearTimeout(timeout);
    const [out, err] = await Promise.all([stdout, stderr]);
    const parsed = parseCodexJsonl(out);
    // Bill BEFORE any early return: a turn that failed or timed out still sent its prefix
    // and was still charged for it. Cached input is billed too (at a discount), so it counts
    // toward the retire budget — undercounting here would let the prefix tax run unbounded.
    if (parsed.usage) {
      this.billedTokens += parsed.usage.input_tokens + parsed.usage.cached_input_tokens;
    }
    // A failed FIRST turn may still have opened a thread; adopt the id so the retry resumes
    // it rather than orphaning a thread we are already being billed for.
    if (parsed.threadId) this.threadId = parsed.threadId;
    if (exitCode !== 0 || timedOut) {
      const detail = timedOut
        ? "Codex turn exceeded 10-minute limit"
        : (err.trim() || out.trim() || `codex exited ${exitCode}`);
      return { ...parsed, ok: false, error: detail };
    }
    if (!parsed.reply) return { ...parsed, ok: false, error: "codex completed without an agent_message" };
    this.lastReply = parsed.reply;
    return { ...parsed, ok: true, error: null };
  }
}

let myId: SeatId | null = null;
let polling = false;

async function main() {
  const config = parseCodexSeatArgs(Bun.argv.slice(2));
  await ensureBroker();
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: config.cwd,
    git_root: await getGitRoot(config.cwd),
    tty: getTty(),
    summary: "",
    role: config.role,
    model: config.model,
    profile: null,
    // Intentionally no seat_token and no session_id; see file comment.
  });
  myId = reg.id;
  log(`Registered as seat ${myId} (cwd: ${config.cwd})`);

  const thread = new CodexThread(config);
  const queue = new SerialTurnQueue();
  const enqueue = (message: DeliveredMessage) => {
    queue.enqueue(async () => {
      const result = await thread.run(buildTurnPrompt(config, message));
      const full = result.ok ? result.reply : `Codex error: ${result.error ?? "unknown failure"}`;
      const seatId = myId ?? "unknown";
      const delivered = truncateForBroker(full, spillPathFor(seatId, message.id));
      // Spill BEFORE delivering: the footer promises a path, so the file must already exist.
      if (delivered.spilled) {
        const path = spillReply(seatId, message.id, full);
        log(`Reply exceeded ${MAX_SEND_BYTES} bytes; full text spilled to ${path}`);
      }
      if (replyDestination(message.from_id) === "summary") {
        // "cli" is not a live seat id, so /send-message would reject a reply.
        // Surface the result in patrol watch through this seat's summary instead.
        const summary = delivered.spilled
          ? `${full.slice(0, 400).replace(/\s+/g, " ")} …[full: ${spillPathFor(seatId, message.id)}]`
          : full.slice(0, 500);
        await brokerFetch("/set-summary", { id: myId, summary });
      } else {
        await brokerFetch("/send-message", { from_id: myId, to_id: message.from_id, text: delivered.text });
      }
    });
  };

  const pollMessages = async () => {
    // Backpressure: don't drain the broker while a turn is queued or running. A turn can
    // hold the queue for the full 10-minute cap, and anything we pulled would sit only in
    // RAM — lost if the seat dies. Leaving it undelivered broker-side means a restart
    // re-delivers it.
    if (!myId || polling || queue.busy()) return;
    polling = true;
    try {
      const { messages } = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
      for (const message of messages) enqueue(message);
    } catch (error) {
      log(`Poll error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      polling = false;
    }
  };

  const pollTimer = setInterval(pollMessages, POLL_INTERVAL_MS);
  const heartbeatTimer = setInterval(async () => {
    if (!myId) return;
    try {
      await brokerFetch("/heartbeat", { id: myId });
    } catch {
      // non-critical: the next heartbeat/poll will retry
    }
  }, HEARTBEAT_INTERVAL_MS);
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
      } catch {
        // best effort
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

if (import.meta.main) {
  main().catch((error) => {
    log(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
