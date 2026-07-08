# Claude-Patrol — R2: Landscape & Feature Research

**Decision this feeds:** Patrol's feature scope + how it ships (build-vs-buy; plugin packaging + marketplace distribution).

**Bottom line:** Rewrite is justified but the moat is narrower than "nobody does peer messaging" — several tools do, including the baseline itself. The niche worth building: the **only** tool combining a *persistent, independent-terminal broker* (long-lived terminals join/leave at will) **+ roles + per-seat cost tracking + message coalescing** in one package. That exact combination exists today only inside Anthropic's own **Agent Teams** — which is session-scoped, lead-spawned, and same-machine (open feature request #28300 asks for Patrol's persistent/cross-machine model; Anthropic hasn't shipped it). Third-party peer-messaging tools (agmsg, amux, Walkie-Talkie, the stalled claude-peers-mcp baseline itself) each have *pieces* but none the full set. Ship as a Claude Code **plugin (MCP + hooks + skills + commands) + a broker binary**, distributed via marketplace + npm — the cc-fleet pattern, verified.

**Confidence:** High on packaging (local evidence) and on the competitor set (source reads + live `gh api`). Med on durability of the niche — see risk below.

**What would change this (the headline risk):** Anthropic extends **Agent Teams** to persistent, cross-session, cross-machine peer messaging (issue **#28300**). That obsoletes Patrol's core from inside the platform. Agent Teams already has mailbox + roles + cost telemetry between separate CC instances; only the session-scoped/same-machine boundary protects Patrol. **Build on top of / complementary to Agent Teams (broker as the discovery + cross-session routing layer it lacks), never against it.**

**Escalation check (does cc-fleet do ≥80% of Patrol?): NO.** cc-fleet is a *provider-swap* tool; its teams ride Claude Code's native SendMessage. It is not a standalone flat broker. Build/buy stays "build." (The closer threat is first-party Agent Teams, flagged above — not a competitor to buy, a platform to build with.)

---

## The competitive reality (corrected)

Independent CC terminals get coordinated three ways today: **tmux send-keys** (claude-squad, Tmux-Orchestrator — brittle, being abandoned), **file-on-disk conventions** (agent-farm JSON, multi-agent-shogun YAML, AMQ maildir), or **broker/MCP peer messaging** (claude-peers-mcp, agmsg, amux, Walkie-Talkie, agent-comms-mcp, and Anthropic's Agent Teams). My first-pass claim that "no tool does flat peer messaging" was wrong — the broker category is real and crowded. Patrol's defensible position is the *combination* below, not the messaging alone.

### First-party gravity: Claude Code Agent Teams (Anthropic)
- **What:** experimental, opt-in since ~v2.1.32 (Feb 2026) via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`. Teammates are **separate CC instances**, each its own context window. Anthropic's docs explicitly distinguish this from subagents: *"in agent teams, teammates share a task list, claim work, and communicate directly with each other."* Mechanism: **mailbox (`SendMessage`)** for direct agent-to-agent messages, **shared task list** with file-locking for claim/dependency coordination, **role templates** (reusable subagent definitions), and **token-cost telemetry** (`/costs#agent-team-token-costs`). — Grade VERIFIED (first-party docs).
- **Why it doesn't collapse the build:** lead-spawned (hub provenance, not independent terminals joining a broker), **session-scoped** (torn down at session end, no resumption, one team per session, no nesting), **same-machine** (panes need tmux/iTerm2). Open Anthropic issue **#28300** ("Multi-agent collaboration across machines / Agent-to-Agent protocol") requests exactly Patrol's model — confirming it's unshipped.
- **Implication:** Patrol = persistent, independently-launched terminals that join/leave a broker at will, cross-session (and eventually cross-machine). Position as the layer Agent Teams lacks.

### Third-party peer-messaging tools (in-scope) — observed 2026-07-08 via `gh api`
| Tool | Stars | Last push | Transport | Roles? | Cost track? | Note |
|---|---|---|---|---|---|---|
| **claude-peers-mcp** (louislva) | **2,146** | 2026-04-26 (stalled ~2.5mo) | Broker daemon `localhost:7899` + SQLite; per-session MCP pushes via channel protocol | No | No | **This is Patrol's baseline/origin.** Public, well-adopted, but momentum stopped. |
| **agmsg** (fujibee) | **971** | 2026-07-08 (today) | Shared local SQLite (WAL), no daemon; monitor-mode push for CC, poll for others | **Yes** (`actas` exclusive locks) + `spawn` | No | Most serious active third-party competitor; cross-vendor (CC/Codex/Gemini/Copilot). |
| **amux** (mixpeek) | 284 | 2026-07-08 (today) | REST API + shared global memory; 1:1 **@mention** messaging + dashboard | Identity only | No | Newest fast-mover; combines messaging + control-plane board. |
| **AMQ / agent-message-queue** (avivsinai) | 65 | 2026-07-07 | Maildir-style (`tmp`→rename→`new`→`cur`), crash-safe, no daemon; `.amqrc` discovery | Co-op Mode | No | Integrates *with* Agent Teams (swarm mode). |
| **Walkie-Talkie** (suruseas) | 10 | 2026-03-08 (stale) | Hub `localhost:9559` + per-agent MCP + HTTP long-poll | No | No | "Slack for CC instances"; flat chat, no orchestration. |
| **agent-comms-mcp** (watchout) | 0 | 2026-07-08 (today) | Postgres `pg_notify` + webhook POST (auto session injection) | No | No | Brand new, churny (178 issues); best *push* mechanism (no polling). |
| **Patrol (ours, target)** | — | — | **Persistent broker + per-seat MCP push** | **Yes** | **Yes** | The unfilled combination. |

**The gap, stated precisely:** no *third-party* tool combines broker messaging + roles + per-seat cost tracking. agmsg has roles; nobody third-party has cost tracking; claude-peers-mcp has the persistent broker but neither roles nor cost. Only Agent Teams has all three — and it's session-scoped. **That is Patrol's whole reason to exist.**

### tmux / file-convention tools (in-scope category, weaker coordination)
| Tool | Stars | Last commit | Mechanism | Messaging |
|---|---|---|---|---|
| claude-squad (smtg-ai) | 8,053 | 2026-06-17 | tmux + git worktrees, TUI | **None** — human switches panes |
| multi-agent-shogun (yohey-w) | 1,398 | 2026-06-06 | YAML on disk + inotifywait + Stop-hook | File-based; send-keys demoted to nudge |
| Tmux-Orchestrator (Jedward23) | 1,800 | 2025-07-14 (stale ~1yr) | tmux send-keys hierarchy | **None** — types strings, scrapes `⏺` from buffer |
| agent-farm (Dicklesworthstone) | 853 | 2026-03-26 | 20–50 tmux panes + shared problems-file | **None** — `[COMPLETED]` markers; prompt-only JSON registry |

- **claude-squad (8,053★, best-adopted):** multiplexing/isolation, not coordination — zero agent-to-agent comms (verified by source grep). Its adoption proves demand for *running* many terminals; the coordination gap above it is Patrol's opening.
- **Tmux-Orchestrator:** direct prior art for the thesis — the ecosystem already abandoned send-keys as a *message* channel (shogun→YAML, agent-farm→JSON). Patrol's broker is the next step past file-polling.
- **agent-farm:** owns a niche Patrol shouldn't chase — 50 workers on one repo with collision-avoidance. Different problem.

### cc-fleet (ethanhq) — inspected in full; the packaging model, not a messaging competitor
- **What:** plugs any provider (DeepSeek/GLM/Kimi/Qwen/MiniMax/Codex) into Claude Code's native Workflow/Team/Subagent lanes as real `claude` processes with swapped backends. Single Go binary + CC plugin. (README + architecture.md, read fully.)
- **Messaging:** uses Claude Code's **native** TeamCreate/SendMessage (hierarchical, experimental flag) — no standalone broker. Cross-process state via files/`flock`.
- **What it gives free (do NOT reimplement — the R2 anti-goal):** a mature **fleet TUI board** (Bubbletea) with teammate/subagent/workflow inbox + status + **USD spend columns** + hold/restart/pin + ghost-process `teardown`; a workflow engine with USD/token budgets; airtight key safety (`apiKeyHelper`, key never in env/argv/history).
- **For Patrol:** borrow the spend-column UX and teardown discipline; the provider-swap and workflow engine are out of scope (don't compete).

### claude-swarm (parruda) — MCP hierarchy, OUT of flat-peer scope; cautionary
- **What:** multiple CC instances communicating via MCP, roles/tools/dirs defined in YAML. 1,708★ (2026-05 Wayback snapshot), ~221,793 `claude_swarm` gem downloads. Active through Feb 2026.
- **Transport:** MCP **tree RPC** — parent's `McpGenerator` writes a per-child MCP config; each child is a `ClaudeMcpServer` exposing a `task` tool; parent calls `mcp__{instance}__task` as a **blocking synchronous** call. Not a message queue, not a broker.
- **Topology:** strict tree (`main` → `connections: [child]`), parent→declared-child only. A worker cannot address a sibling, re-contact its parent proactively, or reach a broker. Each instance is a real process, but access is parent-initiated RPC → **not symmetric peers.** OUT of Patrol's scope.
- **Cautionary signals:** (1) the flagship successor **SwarmSDK v2** explicitly collapses to a *single process*, dropping multi-process MCP messaging — "orchestrate them without the overhead of multiple processes or MCP inter-process communication." The market leader in MCP-instance orchestration walked *away* from independent terminals. (2) Both `parruda/claude-swarm` and `parruda/swarm` **currently 404** (deleted/privated/transferred, cause unverified) — a 1,700★ tool vanished; evidence triangulated from Wayback + live RubyGems. No cost tracking found (UNVERIFIED).
- **Read-through for Patrol:** MCP is a fine transport (Patrol uses it too), but *tree RPC ≠ peer broker*. And a serious builder concluding multi-process MCP wasn't worth the overhead is a data point to take seriously — Patrol's persistence/independence must clearly earn its process cost, or the same logic applies.

---

## Packaging answer: can ONE plugin ship MCP + hooks + skills + commands? **YES — verified locally.**

Evidence from `~/.claude/plugins/cache/` (2026-07-08):
- **MCP in a plugin:** shipped via a `.mcp.json` in the plugin root — present in `shopify-ai-toolkit`, `vercel`, `context7`, `playwright`.
- **Hooks + skills + commands + binary:** cc-fleet ships `hooks/` (`hooks.json` + SessionStart JS), `skills/` (4), commands (`/workflow` `/team` `/subagent`), **and** a compiled Go binary — all under one `.claude-plugin/plugin.json` (v0.2.3).
- **Therefore:** all four types provably package under `.claude-plugin`; combining them in one plugin is supported, and a plugin can bundle a compiled CLI.

**Critical architecture caveat (VERIFIED):** a plugin's hooks/skills/commands run inside short-lived CC processes — a plugin **cannot host an always-on broker**. Patrol's broker must be a **separate long-lived daemon/binary**; the plugin provides the per-seat MCP client + hooks + commands that talk to it. cc-fleet models this exactly (persistent binary/state + thin CC-facing plugin). claude-peers-mcp already splits this way (broker on `localhost:7899` + per-session MCP).

**Marketplace = right distribution.** cc-fleet's `install.sh` installs the plugin "via the marketplace"; GoReleaser feeds one-line installer + npm (`@ethanhq/cc-fleet`) + zips, and `ccf update` refreshes the plugin in one pass. For Patrol: marketplace entry for the plugin half (discovery + one-command install + auto-update), npm/binary channel for the broker half. Dual "binary on PATH + plugin" is the proven shape.

---

## Ranked feature list for Patrol (value ÷ cost, evidence per row)

"HAVE" = in the claude-peers-mcp baseline (broker, per-seat MCP, coalescing, seat role/model metadata, auth, `ccl` launcher). Ranking weights differentiation given the *corrected* landscape (peer messaging alone is now table stakes; the combo is the moat).

1. **Per-seat cost tracking** — BUILD, **top differentiator**, med cost. Evidence: **no third-party peer tool has it** (agmsg/amux/claude-peers-mcp/Walkie-Talkie all lack it); only Agent Teams does. cc-fleet proves the UX (USD spend columns). orchestration.md's whole benchmark (D1 $6.22 vs D3 $2.16; boot-cost $3.6–4.9/idle-seat) turns on per-seat cost, and `benchmarks/token-audit.py` already computes it. This is the single feature that most separates Patrol from the third-party field. Borrow cc-fleet's spend-column UX.
2. **Message coalescing** — HAVE (done). Evidence: still appears unique among peers — agmsg/amux/Walkie-Talkie show no dedup; tmux-orch races on `sleep 0.5`. Keep as a quality differentiator.
3. **Persistent broker + flat directed peer messaging (push delivery)** — HAVE, now *table stakes not moat*. Evidence: claude-peers-mcp (baseline), agmsg, amux, Walkie-Talkie, agent-comms-mcp all do variants. Patrol's edge is *persistence + independent join/leave* (vs Agent Teams' session scope) and push quality. Harden, don't assume it differentiates alone. Note agent-comms-mcp's `pg_notify`+webhook push as the delivery bar to match/beat.
4. **Seat roles / model metadata** — HAVE (partial), now **parity not edge**. Evidence: agmsg has roles (`actas` locks + `spawn`), Agent Teams has role templates. Formalize into the broker's seat registry so board + briefing read it; needed to keep pace, no longer a wow.
5. **Fleet status / mission board** — BUILD, high value, **med-high cost — borrow, don't build from scratch**. Evidence: table stakes (claude-squad TUI, cc-fleet board, amux dashboard, agent-farm). cc-fleet's board is mature (inbox/status/spend/hold/restart/pin/teardown, adaptive). Reimplementing it is the R2 anti-goal — wrap `ccf`'s board or ship a minimal read-only status view over broker state.
6. **Seat health + heartbeat** — BUILD, med value, low-med cost. Evidence: agent-farm (heartbeat + idle/context auto-restart), cc-fleet (`teardown` of ghost processes — a real billing hazard, orchestration.md #2). A heartbeat flagging dead/idle/ghost seats attacks a measured cost leak; ties to #1.
7. **Correct-boot enforcement (never boot on Fable default)** — BUILD, low cost, high ROI. Evidence: orchestration.md #2 — Fable-default boot costs $3.6–4.9/terminal before work; correct boot ≈ $0.4. A `ccl` guard that refuses/warns on default-model boot kills a documented footgun. Small code, direct cost win. (Learned live this session: three peers booted on Fable default before `/model` — exactly this leak.)
8. **Briefing templates per role** — BUILD, med value, low cost. Evidence: delegation-brief skill + orchestration.md seat rules already specify content; package as per-role templates the broker injects on seat join. No competitor has it; cheap; on-brand.
9. **Fleet config file** — BUILD, med value, low cost. Evidence: cc-fleet's strict `config.Load` (reject-not-default) is the model; `ccl` boot profiles exist. One declarative file (seats/roles/models/boot profiles) → reproducible fleets.

**Deprioritize / skip:** provider-swap (cc-fleet owns it); workflow engine (cc-fleet + native Workflow cover it); **cross-machine broker** — tempting given #28300, but every current tool is single-machine and there's no local demand signal yet; defer until Agent Teams forces it or a user asks (YAGNI). Flag #28300 as the strategic watch-item, not a v1 feature.

---

## Contradictions & resolutions
- **"No tool does peer messaging" (my first pass) vs. sweep.** Resolved: false — corrected above. Six+ broker/peer tools exist. The load-bearing claim moved from "messaging is unique" to "the messaging + roles + cost-tracking + persistence *combination* is unique (outside session-scoped Agent Teams)." This is the most important correction in the doc; any Patrol pitch built on "first peer-messaging tool" would be wrong and easily debunked.
- **"Peers beat subagents 2.9×" vs. orchestration.md rules "Default to subagents."** Single-run, machine-specific (spawn tax on MCP-heavy config), and the doc flags "equal gate ≠ equal quality" (D1 subagents *fixed* bugs D3 skipped). Real but narrow — justify Patrol on *workflow fit* (long-lived/stateful/repeated), not a blanket multiplier.
- **cc-fleet "has agent teams" vs. "no peer broker."** Both true, different layers: it uses CC's *native* hierarchical SendMessage, not a standalone symmetric broker.

## What would change this conclusion
1. **Agent Teams ships persistent/cross-machine peer messaging (#28300).** Obsoletes Patrol's core from the platform. Top risk. Mitigate by building complementary to it.
2. **agmsg (971★, active today) adds cost tracking**, or amux adds roles — either closes Patrol's combination gap from the third-party side. Watch both; they pushed today.
3. **The 2.9× reverses on repeat runs** (orchestration.md: repeat before trusting) — weakens the standing-peer cost case but not the workflow-fit case.

## Dead ends
- Pure subagent-orchestration frameworks (Jobim, myclaude, wshobson/agents, awslabs sample-claude-code-agent-team, awesome-claude-code-subagents) — in-session Task delegation, not independent-terminal coordination. Whole category out of scope.
- Operator-mediated / hub-and-spoke dispatchers dismissed after inspection: Citadel (634★, worktree orchestrator), CAO/awslabs (814★, supervisor-worker), NTM (380★, human-relayed mail), claude-fleet (blackboard), fleet (routing CLI), ai-cli-mcp (process manager). None do flat peer messaging.
- Claude Code **Channels** (first-party, external-chat bridge — Telegram/Discord into one session) and **Dispatch** (async job runner) — not agent-to-agent; don't confuse with Patrol's use case.

## Sources (ranked; primaries marked)
- **[PRIMARY]** Anthropic Agent Teams docs (`code.claude.com/docs/en/agent-teams`, `/costs#agent-team-token-costs`) + GitHub issue #28300.
- **[PRIMARY]** cc-fleet README + docs/architecture.md + `.claude-plugin` manifests (local v0.2.3, read fully).
- **[PRIMARY]** Local plugin cache `~/.claude/plugins/cache/` — `.mcp.json`/plugin structure (shopify-ai-toolkit, vercel, context7, playwright, cc-fleet).
- **[PRIMARY]** claude-peers-mcp baseline source (broker.ts, server.ts, cli.ts, peers.test.ts) + `~/.local/bin/ccl`; louislva/claude-peers-mcp public repo (2,146★).
- **[PRIMARY]** `orchestration.md` (Fable Hijack) — benchmark matrix, 2.9× + boot-cost findings.
- **[PRIMARY]** `gh api` reads (2026-07-08): claude-squad, agmsg, amux, AMQ, Walkie-Talkie, agent-comms-mcp, Tmux-Orchestrator, multi-agent-shogun, agent-farm, Citadel, CAO, NTM stars/commits.
- **[PRIMARY]** Source reads: claude-squad (`session/tmux/tmux.go`, `instance.go`, `daemon.go`), agent-farm (`claude_code_agent_farm.py`), Tmux-Orchestrator scripts + issue #2, agmsg/amux/AMQ/Walkie-Talkie/agent-comms-mcp READMEs.
- **[PRIMARY]** claude-swarm: RubyGems API (`claude_swarm.json`, `swarm_sdk.json`, live 2026-07-08) + Wayback snapshots (2025-10-07, 2026-05-06) — canonical repo `parruda/claude-swarm`→`parruda/swarm` both 404 live.
