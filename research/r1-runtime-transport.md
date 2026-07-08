# R1 — Runtime & Transport for Claude-Patrol

**Decision this feeds:** The whole transport + runtime architecture of Claude-Patrol
(ground-up rewrite of claude-peers-mcp). Specifically: (a) does cross-terminal peer
messaging still need an MCP server, (b) if so what is the minimal MCP surface and can
hooks replace delivery, (c) Bun vs Go vs Rust for broker + per-seat process + CLI.

**Bottom line:**
1. **MCP is still required** — for the *receive* path only. No native July-2026 Claude Code
   feature does messaging between **independently-launched** terminal sessions; `agent teams`
   is lead-spawned and one-team-per-session. The push primitive claude-peers relies on
   (`claude/channel`) is now a *native, documented* Claude Code capability (research preview),
   so the design is on a supported path, not a hack about to break.
2. **Hooks cannot substitute for message delivery** — they fire only on Claude Code's own
   lifecycle events and have no external trigger to wake an idle session. Keep the MCP
   channel for receive.
3. **Runtime: stay all-Bun.** The per-seat process must be a Node-compatible runtime because it *is*
   the channel MCP server — and that is where the footprint lives (~40 MB/seat × N ≈ 400 MB at 10
   seats, JS-forced). A Go/Rust broker saves ~24 MB (~5% of total) and its single-binary win is moot:
   seats need a JS runtime on the machine regardless. Not worth a second language on a solo-dev
   codebase. (Rust genuinely wins on isolated footprint — ~7.6 MB vs Bun's ~40 MB — but the broker
   isn't where the footprint is.)

**Confidence:** high on Q1/Q2 (primary Anthropic docs + running code) and on the Q3 conclusion (the
verified architecture constraint dominates the runtime numbers). Softest sub-point: Go's exact idle
RSS lacks a clean measured source — immaterial here since the recommendation is Bun.

**What would change these conclusions:** (a) Anthropic shipping a cross-session peer-messaging
primitive for independent terminals (agent teams gaining shared/cross-session teams), or (b) a
decision to migrate the *workflow* from independent standing seats to a lead-spawns-teammates
model — which would drop the need for a custom transport entirely but changes the product (and
the ~2.9× standing-peers cost advantage the benchmark is built on). See §Contradictions.

---

## Q1 — Does cross-terminal peer messaging still need an MCP server?

**Answer: Yes, for messaging between independently-launched sessions. The native surface does
not cover this use case; the delivery primitive it would use (`claude/channel`) is native but
only reachable through an MCP server.**

### Findings

| # | Claim | Grade | Evidence | Implication |
|---|-------|-------|----------|-------------|
| 1 | `claude/channel` is a **native, documented** Claude Code capability: an MCP server declares `capabilities.experimental['claude/channel']` and emits `notifications/claude/channel` to push a `<channel>` tag into the session. | VERIFIED | code.claude.com/docs/en/channels-reference — "Declare the `claude/channel` capability so Claude Code registers a notification listener; Emit `notifications/claude/channel` events". | claude-peers' core mechanism is a first-class, documented CC feature, not a private hack. |
| 2 | Channels are **research preview**, require **CC v2.1.80+**, and custom (non-allowlisted) channels require `--dangerously-load-development-channels`. | VERIFIED | Same page: "Channels are in research preview and require Claude Code v2.1.80 or later." + "During the research preview, custom channels aren't on the approved allowlist. Use `--dangerously-load-development-channels` to test locally." | The `--dangerously` flag in claude-peers is **expected and current**, not a deprecation signal. Risk: preview API can change; pin CC version, watch the changelog. |
| 3 | A channel MCP server's only hard requirement is `@modelcontextprotocol/sdk` on a **"Node.js-compatible runtime. Bun, Node, and Deno all work."** | VERIFIED | Same page, "What you need". | Locks the *seat* process to a JS runtime (see Q3). |
| 4 | Native **agent teams** exist (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, described as of v2.1.178) with a native `SendMessage` tool, a shared task list, and a mailbox; teammates message each other by name with automatic delivery. | VERIFIED | code.claude.com/docs/en/agent-teams — "Mailbox: Messaging system for communication between agents"; "any teammate can message any other by that name"; "Automatic message delivery … The lead doesn't need to poll." | There IS a native inter-agent messaging system — but scoped to a spawned team (next row). |
| 5 | Agent teams are **lead-spawned and session-scoped**, NOT independent terminals: "An agent team forms when the first teammate is spawned, with the main session acting as the lead"; "**One team per session … You can't create additional named teams or share a team across sessions**"; "Lead is fixed". | VERIFIED | agent-teams, §Architecture + §Limitations. | **Decisive.** Agent teams cannot model N independently-launched terminals discovering each other. The claude-peers/Patrol use case (separate `claude` processes a human started in different terminals) is not expressible as an agent team. Native does **not** replace it. |
| 6 | Subagents are single-session parent→child and "can only report back to the main agent"; for "sessions that communicate with each other" the docs point to agent teams (which row 5 rules out for independent terminals). | VERIFIED | code.claude.com/docs/en/sub-agents — "Subagents work within a single session… For sessions that communicate with each other, see agent teams." | No other native path exists; confirms the gap. |

### Recommendation (Q1)
Keep an MCP server. It remains the **only** way to inject an inbound message into an
independently-launched session (via `claude/channel`). Build Patrol on the native channel
capability directly (declare `claude/channel`, emit `notifications/claude/channel`) rather than
any private protocol — same mechanism, now officially documented. Track the research-preview
status as the top external risk.

---

## Q2 — Minimal MCP surface; can hooks substitute for delivery?

**Answer: The minimal MCP surface is one capability (`claude/channel`) + the poll→notify loop.
Hooks CANNOT substitute for delivery — they have no external/async trigger and cannot wake an
idle session on an inbound peer message.**

### Findings

| # | Claim | Grade | Evidence | Implication |
|---|-------|-------|----------|-------------|
| 7 | The channel notification is the **only** primitive that injects content into a *running* session on an external event; delivery into a busy session is coalesced to the next turn. | VERIFIED | channels-reference, §Notification format — "Events queue into the session and are processed in order. If several notifications arrive while Claude is busy, they're delivered together on the next turn and Claude handles them as a group." | Receive path MUST be an MCP channel server. This is irreplaceable. |
| 8 | Hooks inject `additionalContext` **only at fixed lifecycle points**: SessionStart (before first prompt), UserPromptSubmit (alongside the prompt), PreToolUse/PostToolUse (next to tool result), Stop/SubagentStop (end of turn). | VERIFIED | code.claude.com/docs/en/hooks — event/placement table. | A hook can't deliver a message that arrives while the session sits idle — no lifecycle event fires. |
| 9 | Hooks have **no external trigger**: "Hooks fire only on Claude Code's own lifecycle events"; the closest, `asyncRewake` (wake on exit code 2), still requires the hook to already be running as a background worker the session itself launched. | VERIFIED | hooks doc, cadence list + `asyncRewake` field. | Hooks cannot be fired by "peer B sent you a message." Confirms they can't own the receive path. |
| 10 | The other claude-peers MCP tools (`list_peers`, `send_message`, `set_summary`, `check_messages`) are thin HTTP proxies to the broker; none needs MCP-specific capability — they could be a plain CLI or a `send` that POSTs to the broker. | VERIFIED | Reading server.ts:243–413 (each handler just `brokerFetch`es); broker.ts exposes them as HTTP routes already. | These are convenience, not necessity. The *send* path does not require MCP. |

### Latency / turn semantics — channel vs hooks

| Mechanism | Receive into idle session? | Receive into busy session? | Latency | Verdict |
|-----------|---------------------------|----------------------------|---------|---------|
| `claude/channel` notification | **Yes** — wakes it | Yes — coalesced, delivered next turn | ≈ poll interval (currently 1 s) + notify | Only viable receive path |
| Hook `additionalContext` | **No** — no event fires while idle | Only at next UserPromptSubmit/tool/Stop | Unbounded (waits for local user action) | Cannot own delivery |

### Recommendation (Q2)
- **Keep the MCP server for receive**: `claude/channel` capability + the poll→notify loop. That is
  the whole irreducible MCP surface.
- **Optionally move send/list/summary to a CLI** that POSTs to the broker — but since the MCP
  server is already running for receive, exposing them as MCP tools is nearly free and more
  ergonomic (Claude calls them inline). Keep them as tools; don't add a separate delivery path.
- **Push cadence:** the 1 s poll is a latency floor and a per-seat wakeup cost. Consider a
  longer-lived broker→seat push (SSE/long-poll from broker to the seat process) to cut the
  poll loop; the seat still converts it to a `claude/channel` notification. (Design item for R2,
  not required for correctness.)

---

## Q3 — Runtime: Bun/TS vs Go vs Rust

**Answer (architecture-decisive part, verified): the per-seat process must remain a Node-compatible
runtime because it is the channel MCP server. Only the broker is a free runtime choice.**

### Measured on this machine (2026-07-08, live 7-seat deployment — VERIFIED, `ps -o rss=`)

| Process | Count | RSS each | Notes |
|---------|-------|----------|-------|
| `bun broker.ts` | 1 | **31.8 MB** (32,544 KB) | HTTP :7899 + SQLite (WAL) |
| `bun server.ts` (seat) | 7 | mean **40.4 MB** (41,367 KB), range 36–49 MB | MCP stdio server + 1 s poll + 15 s heartbeat |
| Total (7 seats) | — | **~283 MB** resident | broker + 7 seats |
| Extrapolated @10 seats | — | ~32 + 10×40 ≈ **~432 MB** | LABEL: linear extrapolation, not measured |
| `bun` binary on disk | — | 59.5 MB | single file; `bun 1.2.20` |

Toolchain present: `rustc 1.96.0`; **no Go toolchain installed** (would need install to build/measure).

### Architecture constraint (VERIFIED)

- **Seat process = the channel MCP server** ⇒ per Q1 finding #3 it must be Bun/Node/Deno. Writing it
  in Go/Rust means reimplementing the MCP JSON-RPC stdio protocol **and** the `claude/channel`
  Anthropic extension by hand, tracking an unstable research-preview contract. UNVERIFIED that a
  non-SDK implementation is accepted; high fragility. → **Seat stays JS.** The ~40 MB/seat is a
  JS-runtime floor, largely independent of Bun-vs-Node-vs-Deno choice.
- **Broker = plain localhost HTTP + SQLite**, no MCP ⇒ runtime-free. This is the only place Go/Rust
  can win (lower RSS, single static binary, no runtime prereq). It is a single process at ~32 MB.

### External footprint / distribution benchmarks (sub-agent, deep-synthesis graded)

| Metric | Bun (given/measured) | Go | Rust | Grade / source |
|--------|----------------------|----|------|----------------|
| Idle HTTP-server RSS | 32–49 MB (seat, measured here) | ~10–20 MB | **~7.6 MB** | Rust VERIFIED (measured, aaronriekenberg/rust-hyper-server); Go SINGLE-SOURCE/estimate — **no clean measured trivial-server number found**; Samsara hit a 10–15 MB floor only after `debug.FreeOSMemory()` tuning (VERIFIED prod post) |
| Cold start | 8–15 ms (up to 31) | 0.4–4 ms | 0.5–4.4 ms | Go/Rust VERIFIED tied (bdrung/startup-time); Bun SINGLE-SOURCE (Deno benchmark). **Irrelevant at 1 s poll steady state.** |
| Single static binary, no runtime prereq on target | `bun build --compile` = **55–70 MB** per binary (ships the whole runtime) | Yes, fully static | Yes (musl) | All VERIFIED (bun docs + oven-sh/bun#14546; Go/Rust static-binary write-ups) |
| SQLite + cross-compile | built-in `bun:sqlite`, zero new dep | clean **only** with CGO-free `modernc.org/sqlite` (~2× slower, irrelevant here); mattn/CGO breaks static cross-compile | `rusqlite` bundled needs a C toolchain per target; `cross` (Docker) packages it | VERIFIED (mattn#855, rusqlite#914, modernc docs). Go-vs-Rust cross-compile is a **wash** once C-linked SQLite is involved. |
| Solo-dev maintenance | one language (TS) for broker+seats+CLI, no FFI/driver risk | mature, simple if `modernc` chosen | mature (`rusqlite` 40M dl), but 2nd toolchain | — |

### The decisive synthesis (constraint the benchmarks alone miss)
**The footprint does not live in the broker.** Seats are JS-forced at ~40 MB each (Q1 #3), so
10 seats ≈ **400 MB regardless of broker language**. Rewriting the broker in Rust saves ~24 MB
(32→~8) out of a ~432 MB total — **~5%**. And the single-binary/no-prereq distribution win is
**moot**: the seats *are* MCP channel servers and need a Bun/Node runtime on the machine no matter
what, so a native broker doesn't remove the JS prerequisite. Meanwhile a Go/Rust broker adds a
second language, toolchain, and SQLite story to a solo-dev codebase whose seats stay TypeScript.

### Recommendation (Q3) — final
**Stay all-Bun** (broker + seat + CLI):
- **Seat: Bun** — forced by the channel/MCP runtime requirement; not a real choice. The ~40 MB is a
  JS floor; Node/Deno swap in but win nothing and lose Bun's built-in `bun:sqlite` + `--compile`.
- **Broker: Bun** — the ~24 MB a Rust broker would save is ~5% of total, the distribution win is
  moot (seats need JS anyway), and one language is the lower-maintenance choice for a solo dev.
- **Do NOT** ship seats via `bun build --compile` for distribution: 55–70 MB per binary × N seats
  is worse than a one-time `bun`/`npm install`. Distribute as TS run by a single installed Bun.

**Reversal condition:** this flips only if the architecture changes so the seat is no longer the
JS channel server — e.g. a thin **native (Go/Rust) sidecar** owns the 1 s broker poll and per-seat
state, leaving a near-idle minimal JS shim to hold just the `claude/channel` capability. Then the
bulk of per-seat RSS moves to a 7–15 MB native process and a native broker becomes consistent with
it. That is an R2 design question; if pursued, first run the 10-minute local `ps` measurement of a
Go `net/http` idle server the sub-agent flagged (the one number it could not verify cleanly).

---

## Contradictions & resolutions

- **"Native messaging exists" vs "MCP still needed."** Both true, different scopes. Agent teams give
  native inter-agent messaging *within a lead-spawned, session-scoped team*; they do not give
  messaging between *independently-launched* terminals. Resolved: the native feature and the
  claude-peers use case address different topologies. The real question is whether the *product*
  should keep the independent-terminal topology (see below) — an escalation item, not a research
  contradiction.
- **Product-level tension (flagged, not resolved here):** If Patrol's workflows could be run as
  lead-spawns-teammates (agent teams), the custom transport becomes unnecessary. But that abandons
  the independent standing-seat model that the benchmark measured at ~2.9× cheaper than subagents,
  and agent teams' own docs say they "use significantly more tokens than a single session." Whether
  to keep independent seats is an architecture decision above R1; this doc assumes the independent-
  terminal topology is a requirement (it is the stated premise of the rewrite).

## Dead ends
- Hooks as a delivery transport — ruled out (findings 8–9); don't re-investigate.
- Go/Rust for the seat process — ruled out by the channel/MCP runtime requirement; don't re-price it.

## Sources (ranked; primaries marked)
1. **[PRIMARY]** code.claude.com/docs/en/channels-reference — channel capability, notification format, research-preview status, runtime requirement.
2. **[PRIMARY]** code.claude.com/docs/en/agent-teams — team architecture, one-team-per-session, lead-spawned, SendMessage/mailbox.
3. **[PRIMARY]** code.claude.com/docs/en/hooks — hook events/cadence, additionalContext placement, asyncRewake, no external trigger.
4. **[PRIMARY]** code.claude.com/docs/en/sub-agents — subagent scope, pointer to agent teams.
5. **[PRIMARY]** ~/claude-peers-mcp/{server.ts,broker.ts,README.md} — the running implementation (v0.2.0).
6. **[PRIMARY]** live `ps -o rss=` measurement on this machine, 2026-07-08 (broker 31.8 MB; 7 seats mean 40.4 MB).
7. **[PRIMARY]** aaronriekenberg/rust-hyper-server (measured ~7.6 MB RSS); bdrung/startup-time (Go/Rust cold start); bun docs + oven-sh/bun#14546 (`--compile` 55–70 MB); mattn/go-sqlite3#855, rusqlite#914, modernc.org/sqlite docs (SQLite cross-compile). Via R1 sub-agent, deep-synthesis graded.
8. [SECONDARY] Samsara "Running Go on Low Memory Devices" (10–15 MB Go floor, post-tuning); Deno cold-start benchmark (Bun ~8–15 ms). Directional only.
