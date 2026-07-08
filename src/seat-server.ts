#!/usr/bin/env bun
/**
 * claude-patrol seat server — the per-seat stdio MCP server (one per session).
 *
 * MINIMAL surface (DESIGN D1): its only jobs are register, poll the broker, and
 * push coalesced inbound messages via the claude/channel capability. Active
 * verbs (send, list) are CLI commands, not MCP tools — that keeps the per-seat
 * schema payload near zero. Two tools remain: set_summary (a seat must be able
 * to self-describe without shelling out) and check_messages (manual fallback if
 * channel push is unavailable).
 *
 * Usage: claude --dangerously-load-development-channels server:claude-patrol
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getSecret, TOKEN_HEADER } from "../shared/auth.ts";
import { findSessionIdByHeuristic } from "./costs.ts";
import { SEAT_TOKEN_ENV, SEAT_TOKEN_RE } from "../shared/types.ts";
import type {
  SeatId,
  RegisterResponse,
  PollMessagesResponse,
  DeliveredMessage,
} from "../shared/types.ts";

const BROKER_PORT = parseInt(process.env.CLAUDE_PATROL_PORT ?? "7900", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

function log(msg: string) {
  // stdio MCP servers must keep stdout for the protocol; log to stderr only.
  console.error(`[claude-patrol] ${msg}`);
}

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [TOKEN_HEADER]: getSecret() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2500), // a wedged broker must not hang a poll forever
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
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], { stdio: ["ignore", "ignore", "inherit"] });
  proc.unref(); // survive this server exiting
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
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
    const ppid = process.ppid;
    if (!ppid) return null;
    const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
    const tty = new TextDecoder().decode(proc.stdout).trim();
    return tty && tty !== "?" && tty !== "??" ? tty : null;
  } catch {
    return null;
  }
}

// Best-effort CC session-id discovery for exact cost attribution. Claude Code
// generates the session id internally after launch and does not hand it to
// spawned MCP servers, so we infer it: the one session log freshly touched in
// this seat's project dir. Ambiguity (0 or >1 fresh logs) degrades to null and
// the broker's fallback attribution takes over — never misattribute. An env
// override wins if CC ever exposes it directly.
function discoverSessionId(cwd: string): string | null {
  const override = process.env.CLAUDE_PATROL_SESSION_ID;
  if (override) return override;
  const projectsRoot = process.env.CLAUDE_PATROL_PROJECTS_ROOT ?? `${process.env.HOME}/.claude/projects`;
  try {
    return findSessionIdByHeuristic({ cwd, projectsRoot, nowMs: Date.now() });
  } catch {
    return null;
  }
}

// --- State ---
let myId: SeatId | null = null;
let polling = false; // guards against overlapping poll ticks when the broker is slow

// --- MCP server ---
const mcp = new Server(
  { name: "claude-patrol", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are a seat on the claude-patrol network. Other Claude Code seats on this machine can message you.

IMPORTANT: When you receive a <channel source="claude-patrol" ...> message, RESPOND IMMEDIATELY. Pause what you are doing, reply, then resume. Treat it like a coworker tapping your shoulder. A single notification may carry several coalesced messages (separated by --- with per-message [from ...] headers) — handle all of them.

To send a message, list seats, or check fleet status, use the \`patrol\` CLI via Bash (\`patrol send <id> <msg>\`, \`patrol list\`, \`patrol status\`) — these are not MCP tools. This server exposes only:
- set_summary: describe what you're working on (other seats see it)
- check_messages: manually pull queued messages (fallback; normally they arrive automatically)

When you start, call set_summary to describe your work.`,
  }
);

const TOOLS = [
  {
    name: "set_summary",
    description: "Set a brief (1-2 sentence) summary of what you are working on. Visible to other seats.",
    inputSchema: {
      type: "object" as const,
      properties: { summary: { type: "string" as const, description: "1-2 sentence summary" } },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually pull queued messages from other seats. Messages normally arrive automatically via channel push; use this only as a fallback.",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

function formatInbound(m: DeliveredMessage): string {
  const who = [m.from_id, m.from_role, m.from_model].filter(Boolean).join(" · ");
  const summary = m.from_summary ? ` — ${m.from_summary}` : "";
  return `[from ${who}${summary} at ${m.sent_at}]\n${m.text}`;
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (!myId) {
    return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
  }
  try {
    switch (name) {
      case "set_summary": {
        const { summary } = args as { summary: string };
        await brokerFetch("/set-summary", { id: myId, summary });
        return { content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }] };
      }
      case "check_messages": {
        const { messages } = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (messages.length === 0) return { content: [{ type: "text" as const, text: "No new messages." }] };
        return {
          content: [
            {
              type: "text" as const,
              text: `${messages.length} new message(s):\n\n${messages.map(formatInbound).join("\n\n---\n\n")}`,
            },
          ],
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
      isError: true,
    };
  }
});

// Coalesce the whole poll batch into ONE channel notification: each
// notification wakes the session for a full turn at full context price, so N
// messages must not cost N turns. Sender context is joined by the broker.
async function pollAndPushMessages() {
  // Skip if a prior tick is still in flight — a wedged broker plus a 1s interval
  // would otherwise pile up unbounded concurrent polls.
  if (!myId || polling) return;
  polling = true;
  try {
    const { messages: msgs } = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
    if (msgs.length === 0) return;
    if (msgs.length === 1) {
      const m = msgs[0]!;
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: m.text,
          meta: {
            from_id: m.from_id,
            from_summary: m.from_summary ?? "",
            from_cwd: m.from_cwd ?? "",
            from_role: m.from_role ?? "",
            from_model: m.from_model ?? "",
            sent_at: m.sent_at,
          },
        },
      });
    } else {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msgs.map(formatInbound).join("\n\n---\n\n"),
          meta: {
            message_count: String(msgs.length),
            from_ids: [...new Set(msgs.map((m) => m.from_id))].join(","),
          },
        },
      });
    }
    log(`Pushed ${msgs.length} message(s) in one notification`);
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    polling = false;
  }
}

async function main() {
  await ensureBroker();

  const cwd = process.cwd();
  const gitRoot = await getGitRoot(cwd);
  const tty = getTty();

  // Register the PARENT (claude) process, not this MCP server: broker liveness
  // must track the actual claude process, and the SessionEnd hook deregisters
  // by its $PPID = the claude pid. Registering process.pid (the MCP server)
  // instead left the hook's dereg-by-pid join with nothing to match. Fall back
  // to our own pid if ppid is unavailable (0/undefined).
  const claudePid = process.ppid || process.pid;
  const envToken = process.env[SEAT_TOKEN_ENV];
  const seatToken = envToken && SEAT_TOKEN_RE.test(envToken) ? envToken : null;

  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: claudePid,
    cwd,
    git_root: gitRoot,
    tty,
    summary: "",
    role: process.env.CLAUDE_PATROL_ROLE ?? null,
    model: process.env.CLAUDE_PATROL_MODEL ?? null,
    profile: process.env.CLAUDE_PATROL_PROFILE ?? null,
    session_id: discoverSessionId(cwd),
    seat_token: seatToken,
  });
  myId = reg.id;
  log(`Registered as seat ${myId} (cwd: ${cwd})`);
  if (reg.session_id_rejected) {
    log("session_id claim rejected (another live seat holds it) — this seat's costs will be unattributed");
  }

  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });
      } catch {
        // non-critical
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = async () => {
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

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
