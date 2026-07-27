# Competitive landscape & feature-theft report — for PatrolPrime

**Decision this feeds:** what Claude-Patrol builds next (steal), refuses (anti-bloat), and watches. Roadmap prioritisation, mid-2026.

**Bottom line:** Patrol sits in a crowded field but no competitor covers its full stack (per-seat cost + inter-seat broker + YAML launcher + planned worktree/board). Three features are cheap, high-value, and on-mission — steal them now: **worktree-per-seat as a first-class launcher primitive**, **one-command merge-back (`checkpoint`)**, and **budget alerts on the existing cost ledger**. The field's cautionary tale is claude-flow/ruflo (87→171→210 tools across its own docs): the discipline that wins this niche is a small, stable command surface, not feature count. Refuse the SaaS/GUI/kanban-weight/k8s-backend temptations — they're where competitors are dying or bloating.

**Confidence:** med-high on the matrix (all primary-sourced READMEs/docs), med on maturity numbers (stars are web-sourced, several unverified). **What would change this:** if worktree isolation proves to fight Patrol's standing-seat model (seats are long-lived; worktrees assume task-scoped throwaway checkouts) — that tension is the riskiest untested assumption below.

---

## Part 1 — The full matrix (forest from the trees)

15 tools, grouped by what they actually are. Legend: ✅ has it · ⚠️ partial/caveated · ❌ absent · ? unverified.

### A. Terminal fleet managers (Patrol's direct niche)

| Tool | Isolation | Inter-agent comms | Cost/seat | Task mgmt | UI | Launcher config | Maturity | License |
|---|---|---|---|---|---|---|---|---|
| **Claude-Patrol** (us) | worktree (planned) | **broker (coalesced push)** ✅ | **✅ per-seat, 3 wallets** | claims + board (planned) | live TUI | **YAML** ✅ | pre-1.0, 1 dev | AGPL-3.0 |
| claude-squad | worktree ✅ | ❌ | ❌ | ❌ | TUI + diff pane | config.json | ~8.2k★, active | AGPL-3.0 |
| herdr | process/pane only | **✅ Unix-socket API** (spawn+monitor peer) | ❌ | ❌ | TUI, mouse, auto-state sidebar | none (multiplexer) | ~11–19k★ (?), active | AGPL-3.0 |
| ccmanager | worktree ✅ | ❌ | ❌ | ⚠️ status hooks | TUI | per-tool | ~1.2k★, active | MIT |
| uzi | worktree + tmux + **auto port-alloc** | ⚠️ one-way `broadcast` | ❌ | ⚠️ `checkpoint` merge-back | none (CLI) | CLI flags | ~579★, small | MIT |
| Solo (soloterm) | ❌ shared | ⚠️ MCP: todos/notes/**locks** | ❌ | shared todos | **desktop GUI** | hosts running CLIs | proprietary, paid | closed |
| crystal → Nimbalyst | worktree ✅ | ? (task handoff) | ❌ | ⚠️ plan handoff | **Electron GUI + Monaco** | project workspace | ~3.1k★ **renamed/dead-ended** | MIT |

### B. Sandbox / task-board / monitoring layers

| Tool | Isolation | Inter-agent comms | Cost/seat | Task mgmt | UI | Maturity | License |
|---|---|---|---|---|---|---|---|
| container-use | **Docker container + branch/agent** (strongest) | ? | ❌ | ❌ (substrate) | CLI/git, attach-to-terminal | ~3.9k★, Dagger-backed | Apache-2.0 |
| vibe-kanban | worktree + lifecycle cleanup | implicit via board | ❌ | **✅ full kanban + PR-gen** | **web board + browser** | ~27.5k★ **but sunsetting** | Apache-2.0 |
| omnara | ❌ (monitoring layer) | ❌ (human↔agent) | ❌ | activity feed | **web + native iOS/Android + TUI** | YC S25, hosted | Apache-2.0 |

### C. Orchestration frameworks (heavier, MCP/swarm)

| Tool | Isolation | Inter-agent comms | Cost/seat | Config | Tool count | Maturity | License |
|---|---|---|---|---|---|---|---|
| claude-flow / ruflo | memory namespace (not fs) | **blackboard** (vector AgentDB + RAG) | **✅ cost-tracker + budget alerts** | 60+ CLI cmds, plugins | **87→171→210 (docs disagree)** | large, hyped | MIT |
| Claude Swarm | **fs (directory/instance)** ✅ | MCP point-to-point (`task`) | ⚠️ `ps`/`show` **but blind to main instance** | 1 clean YAML tree | ~10 CLI cmds | orig repo **404'd**, gem live | MIT |
| claude-peers-mcp (our ancestor) | ❌ | broker (1/msg, no coalesce) | ❌ | 3 env vars | 4 MCP tools | small floor | MIT |

### D. Wildcards (not direct competitors — idea sources)

| Tool | What it actually is | Competitor? | The one idea |
|---|---|---|---|
| Terminal Graph | macOS spatial-canvas window manager | ❌ no | reactive canvas as a fleet-board *metaphor* |
| fusion-harness | dual-model ARCHITECT/BUILDER harness for one task | adjacent | **gate-first validation** (write acceptance criteria before build) |
| gascity | declarative orchestration SDK, supervisor reconcile-loop | closest SDK analog | **swappable runtime backend** (tmux\|subprocess\|k8s from one config) |

---

## Part 2 — Contradiction resolved (the load-bearing claim)

**Prior going in:** "no competitor tracks per-seat cost — it's Patrol's clean differentiator." **This is false and must not go in any pitch.** claude-flow/ruflo ships a `cost-tracker` plugin with budget alerts; Claude Swarm has `ps`/`show` per-session cost.

**Resolution (the real, defensible position):** cost tracking exists *only in the two heaviest orchestration frameworks*, and **not in a single terminal-fleet manager** (claude-squad, herdr, ccmanager, uzi, Solo, crystal, container-use, vibe-kanban, omnara — all ❌). Even where it exists it's flawed: Claude Swarm's own docs admit the **main instance's cost is untracked interactively** — usually the most expensive seat. So Patrol's honest claim is narrower and stronger: *"the only fleet-manager that tracks cost per seat, without the blind spot the one framework that tries has, split across the three real billing wallets none of them model."* [VERIFIED across all 4 sweeps.]

---

## Part 3 — STEAL (ranked by value ÷ complexity)

1. **Worktree-per-seat, first-class in the launcher** — VERIFIED near-universal (claude-squad, ccmanager, crystal, uzi, vibe-kanban; container-use does it one level up with containers). It's table stakes for parallel file-safe work, and Patrol only has it half-planned (v0.3 codex writable-worktree). *Value: high. Complexity: med.* Riskiest assumption (see below) — validate the standing-seat/worktree tension first.
2. **One-command merge-back (`uzi checkpoint`)** — named git-rebase of a seat's worktree onto main in one verb. Turns "seat done in its tree" into "clean commit" without hand-driving rebases. Pairs directly with #1. *Value: high. Complexity: low.*
3. **Budget alerts on the cost ledger** — Patrol already has the per-seat ledger; claude-flow proves the missing half is *alerting at a threshold*, not more readout. A seat crossing $X pings the orchestrator. *Value: high. Complexity: low* (ledger + one comparator; reuses the broker).
4. **Per-seat diff/preview pane (claude-squad)** — review a seat's uncommitted changes from `patrol watch` / the v0.2.5 dashboard without cd-ing in. *Value: med-high. Complexity: med.* Slots into the already-planned dashboard.
5. **Status-change hooks (ccmanager)** — run an arbitrary command on a seat state transition. The broker already sees `/set-state` (v0.2.4); exposing a hook is cheap general automation (notify, trigger CI, log). *Value: med. Complexity: low.*
6. **Heuristic state *fallback* (herdr)** — Patrol's self-reported `/set-state` is *better* than herdr's guessing, but add herdr's blocked/working/done/idle heuristic as a **fallback for seats that never report** (e.g. a plain `claude` a user launched by hand). *Value: med. Complexity: low-med.*
7. **Gate-first validation (fusion-harness)** — let a fleet task carry a pre-declared acceptance gate the seat must pass before its worktree can `checkpoint`. Turns review from bolted-on to structural. *Value: med. Complexity: med.* Natural once #1+#2 exist.

---

## Part 4 — DO NOT STEAL (anti-bloat list — the point of this exercise)

1. **Tool-count sprawl (claude-flow/ruflo, 87→171→210).** The single clearest failure mode in the field — its own docs can't agree on the number. Patrol's edge is a small, memorizable verb set. Every new command must earn its place; publish the count and hold it.
2. **Blackboard vector memory / RAG / self-learning (claude-flow AgentDB + SONA).** Enormous complexity, unproven value for a *coordinator*. Patrol's broker is message-passing, not a knowledge base — keep it that way.
3. **Full kanban board + PR-generation as core (vibe-kanban).** 27.5k stars **and sunsetting** — the loudest signal in the sweep. Steal the *concept* (work visibility) at TUI/read-mostly weight for the v0.2.5 dashboard; do **not** build a web app that creates/prioritises issues and opens PRs. That weight is where vibe-kanban is dying.
4. **Desktop/Electron GUI (crystal→Nimbalyst, Solo).** Off-mission for a terminal-first CLI; crystal already had to rename/pivot out of it. A live TUI + a lightweight broker-served page is the ceiling.
5. **Swappable k8s/cloud runtime backends (gascity).** YAGNI — Patrol is single-machine *by design* (it's in DESIGN.md). Adopt the *config shape* (`backend:` field, already present) but not the k8s/cloud providers until cross-host is a real goal.
6. **Hosted SaaS backend (omnara, Solo pricing).** Patrol is local, self-hosted, AGPL. A cloud dependency breaks that and adds an account/billing surface. Mobile approve-from-phone is genuinely nice UX — but it's the *reason* omnara needs a hosted backend, so it's a WATCH, not a steal.
7. **Multi-model role harness (fusion-harness ARCHITECT/BUILDER).** That's a single-task orchestration pattern, not a fleet feature. Only the gate-first *idea* (Steal #7) crosses over; the dual-model machinery does not.
8. **Spatial-canvas visualisation (Terminal Graph).** Cute metaphor, heavy to build, and it isn't even an agent tool. A flat fleet board is sufficient and cheaper.

---

## Part 5 — WATCH (not now, but track)

- **container-use (container isolation).** Strictly stronger than worktrees (deps/servers/env fully sandboxed, human can attach to a live agent terminal). But Docker is a heavy default. Offer as an *optional* `backend: container` later; don't default to it.
- **omnara mobile/headless.** Approve-a-diff-from-your-phone is the best UX in the sweep. Gated behind a hosted backend, so pair-don't-compete for now; revisit if Patrol ever grows a remote surface.
- **vibe-kanban sunset — find out why.** 27.5k stars folding is a live lesson about whether kanban-for-agents has real demand or just star-appeal. Cheap intel, high signal for the v0.2.5 dashboard scope.
- **Claude Swarm SwarmSDK.** Original repo 404'd; a decoupled successor is referenced. Watch for the relaunch — it's the closest philosophical cousin (clean YAML, real isolation).

---

## Riskiest assumption (test this first, per plan discipline)

**Worktrees assume task-scoped throwaway checkouts; Patrol's whole thesis is *standing* seats that amortise context over many tasks.** A seat pinned to one worktree for its lifetime may fight that model (which worktree does a long-lived reviewer seat live in? does merge-back kill the seat or recycle it?). Every competitor doing worktrees (uzi, claude-squad, vibe-kanban) treats the agent as *task-scoped and disposable* — the opposite of a standing seat. **Resolve this design question before building Steal #1**, or the cheap-looking feature drags the core model sideways. One concrete test: run a standing `reviewer` seat across three sequential worktree tasks and see whether the worktree-per-task model or the standing-seat model has to bend.

---

## Vocabulary (verbatim, for copy)
- "tmux, but agent-aware" (herdr) · "command center for AI agents" (omnara) · "run and preview the diff without leaving the app" (crystal) · "each workspace gives an agent a branch, a terminal, and a dev server" (vibe-kanban) · "isolated containerized environment per agent" (container-use).

## Dead ends
- parruda/claude-swarm repo 404s (deleted/private) — stars/commits unverifiable; use the gem + fork mirror. Terminal Graph is a window manager, not an agent tool — don't re-research it as a competitor.

## Sources (primary, ranked by weight)
claude-flow/ruflo README + deepwiki tool ref · Claude Swarm gem v1.0.6 + stevegeek fork README · claude-peers-mcp README/package.json · dagger/container-use README · BloopAI/vibe-kanban README · omnara-ai/omnara README · smtg-ai/claude-squad README · ogulcancelik/herdr README · kbwo/ccmanager README · devflowinc/uzi README · stravu/crystal README · soloterm.com · disler/fusion-harness README · gastownhall/gascity README · terminalgraph.com.

---
---

# REVISION — 2026-07-27

**Why this exists:** the sweep above missed the two largest tools in the field. It
surveyed 15 tools; it did not see stablyai/orca (30,059 stars) or manaflow-ai/cmux
(25,194 stars). Cause: the search vocabulary was Claude-Code-centric ("claude code
multiplexer", "parallel claude sessions") and GitHub-topic-driven. The tools that
matter most brand as vendor-neutral "ADEs" for "a fleet of parallel agents" and lead
with a desktop app, so they matched none of it. Re-swept with corrected vocabulary.

All figures below are from `gh api repos/OWNER/REPO`, not scraped pages. All
capability claims cite a file path read first-hand in a depth-1 clone.

## Three claims from the report above are DEAD

**1. "No competitor covers Patrol's full stack" — FALSIFIED.**
`jayminwest/overstory` (1,329★, MIT, created 2026-02-12, **archived 2026-05-28**) built
the same architecture independently:
- `src/mail/store.ts:55` — `CREATE TABLE messages (from_agent, to_agent, subject, body,
  type, priority, thread_id, read, created_at)`, `PRAGMA journal_mode = WAL`, 5s busy
  timeout. That is Patrol's broker, field for field.
- `src/metrics/store.ts:49` — `agent_name`, `parent_agent`, `estimated_cost_usd`.
  Per-agent cost WITH subagent rollup.
- `src/commands/costs.ts` — `ov costs [--agent <name>] [--run <id>] [--by-capability]`.
- YAML config, 11 pluggable agent backends.

It was built in February and archived in May. Its successor (`jayminwest/warren`,
126★, active) abandoned worktrees for bwrap/k8s containers and kept only per-*run*
cost. **The closest architectural twin Patrol has died in three months.** That is a
warning about the category, not a moat.

**2. "No terminal fleet manager tracks per-seat cost" — FALSIFIED.**
`asheshgoplani/agent-deck` (605★) reads Claude Code transcripts via hook integration
and shows per-session dollar cost across 14 priced models in its TUI.

**3. "Don't build a GUI — crystal had to pivot out of Electron" — MISREADING.**
Crystal did not retreat from a GUI. Nimbalyst is a *larger* Electron app (kanban,
visual markdown/mockup editors) plus native iOS/Android. No maintainer statement
anywhere blames the GUI. Meanwhile GitHub and OpenAI both shipped standalone desktop
apps for this exact category in 2026; GitHub's stated reason: *"most developer tools
were not designed for directing multiple agents in parallel."* **DO-NOT-STEAL #4 is
struck.** GUI is not a losing move here. (Caveat: star counts measure interest, not
retention. No DAU data exists for any tool in this sweep.)

## Tools the first sweep missed (all `gh api` verified)

| tool | ★ | what it is | comms | cost |
|---|---|---|---|---|
| stablyai/orca | 30,059 | vendor-neutral agent ADE, desktop+mobile+VPS | **YES** (see below) | $ by model/project/run |
| manaflow-ai/cmux | 25,194 | Ghostty-fork macOS terminal for agents | no | per-turn echo only |
| superset-sh/superset | 12,625 | "The Code Editor for AI Agents", 12 backends | no | none |
| AgentWrapper/agent-orchestrator | 8,601 | 23 backend adapters, desktop | no | none |
| agent-of-empires | 2,881 | TUI + web/mobile, tmux+worktree+container | no | none |
| AgentsMesh | 2,300 | "AgentPod" per agent, channels + @mentions | **YES** | unverified |
| 0-AI-UG/cate | 1,993 | infinite-canvas Electron workspace | no | none |
| coder/mux | 1,938 | desktop+browser, local/worktree/SSH modes | no | **per-agent, "Costs tab"** |
| jayminwest/overstory | 1,329 | **archived** — see above | **YES** | **per-agent $** |
| nimbalyst/nimbalyst | 1,327 | crystal's successor, bigger GUI + mobile | no | none |
| dohooo/helmor | 1,278 | local-first workbench | no | none |
| johannesjo/parallel-code | 893 | dispatch N agents, review diffs | no | none |
| asheshgoplani/agent-deck | 605 | TUI fleet manager | orchestrator-relayed | **per-session $** |
| jayminwest/warren | 126 | overstory's successor, containers/k8s | "Plot" shared context | per-run $ |

## Orca — corrected reading (first-hand, `/tmp/orca-verify`)

**It HAS inter-agent messaging.** The first pass of this revision said it did not; that
was wrong, and wrong the same way the original sweep was — stopping at the first
plausible answer. `src/shared/external-worktree-inbox.ts` is a list of discovered
worktrees, not a mailbox; `handoff` is UI session handoff. The real thing is elsewhere:

- `src/main/runtime/orchestration/db.ts:111` — `CREATE TABLE messages (from_handle,
  to_handle, subject, body, type CHECK(type IN (status|dispatch|worker_done|
  merge_ready|escalation|handoff|decision_gate|heartbeat)), priority, thread_id,
  payload, read, sequence)`, plus `tasks` (`parent_id`, `deps` JSON, status enum),
  `dispatch_contexts` (`failure_count`, `circuit_broken`), `decision_gates`,
  `coordinator_runs`. WAL mode. `CREATE INDEX idx_inbox ON messages(to_handle, read)`.
- Delivery is pty keystroke injection: `rpc/methods/orchestration.ts:505-511` →
  `orca-runtime.ts:13783`, gated on `isTerminalRunningAgent` (names claude, codex,
  gemini, droid, cursor).
- 15 `orca orchestration *` verbs including a blocking `ask`.

**Its cost IS dollars.** `src/main/claude-usage/store.ts:61` `MODEL_PRICING`, `:234`
`estimateCostUsd()`, applied at `:492` and `:628`; `src/shared/claude-usage-types.ts`
carries `estimatedCostUsd`. Scanned from `~/.claude/projects` — the same source Patrol
uses. (A sub-agent grepped `src/main/claude-usage/types.ts`, got 0 hits, and reported
"no dollar cost anywhere". The cost lives in `store.ts`. Cited here because the failure
mode — grep one file, generalise to the codebase — is the same one that produced all
three dead claims above.)

**Its headline feature does not exist in code.** README: *"Fan one prompt across five
agents... compare the results and merge the winner."* There is no fan-out dispatcher,
no multi-worktree comparison renderer, no winner-merge action. `DiffViewer.tsx` is an
ordinary single-worktree-vs-base view. "Fan, compare, merge" is a human making N
worktrees by hand. Either an opportunity (build the real thing) or a signal nobody
found it worth building — 30k stars did not need it.

**It has no local merge-back at all.** `git merge`/`git rebase` appear only to detect a
conflict and `--abort` it. Landing goes through `gh pr create` → `gh pr merge --squash`;
conflicts are punted to GitHub's web UI.

## What actually survives as Patrol-only

Stated narrowly, because the wide version was wrong:
1. **Cost attributed to a named standing seat**, with subagent rollup and a three-wallet
   split. Orca has dollars but bins them by model/project/run and never joins them to
   the agent handles its own coordinator addresses. Overstory did join them, and is dead.
2. **Local merge-back.** `checkpoint` — throwaway integration worktree, three fences, a
   quiescing lease, `INCOMPLETE` over false success — has no counterpart in the largest
   tool in the field.
3. **A lean headless broker.** Orca's `orca serve` is the full Electron app under Xvfb;
   its top-voted open issue is **#4280 "First-class headless / server mode" (16👍)**.
   Patrol's broker is a Bun process with no GUI dependency. Win to state, not parity to chase.

## STEAL — additions (numbering continues from Part 3)

Five of six cost no new verbs. Total surface: 20 → 21.

8. **PTY prompt injection as a delivery fallback.** Orca writes bytes into the target's
   live pty, backend-agnostic. Patrol's delivery depends on `claude/channel`, a research
   preview behind an interactive consent gate — which is exactly why `bg` seats cannot
   receive messages today. This closes that hole. *Low-med complexity, 0 verbs.*
9. **Declarative backend config table.** `TUI_AGENT_CONFIG: Record<TuiAgent,
   TuiAgentConfig>` with a `promptInjectionMode` enum (`argv | flag-prompt |
   stdin-after-start | ...`) covers ~35 agents as data; there are zero `agent === 'codex'`
   branches in the 1.2MB runtime. Patrol hand-writes `codex-seat.ts` and
   `headless-seat.ts`. Vendor neutrality for the price of a config table. *Med, 0 verbs.*
10. **Rate-limit headroom, not just spend.** Orca queries
    `api.anthropic.com/api/oauth/usage` for `five_hour`/`seven_day` windows, falling back
    to scraping the CLI's `/usage` panel. On a subscription, "this seat is at 80% of its
    5-hour window" is more actionable than a dollar figure. *Low, 0 verbs.*
11. **Orphan-gitdir proof + removal guardrails.** `worktree-orphan-gitdir-proof.ts`
    round-trips a stale `.git` file's `gitdir:` pointer against the repo's
    `.git/worktrees/<name>/gitdir` back-reference before deleting anything;
    `worktree-removal-safety.ts` refuses repo root, `/`, `$HOME`, `/Users/*` and requires
    provenance metadata. Its comment is the principle: *"path shape alone is not
    authority."* Hardens `checkpoint`. *Low, 0 verbs.*
12. **Blocking `ask` with timeout.** `ask --to <handle> --question --timeout-ms`, backed
    by a `decision_gate`-typed message on the existing bus. A seat mid-task needing a
    peer's answer — not a handoff — has no clean primitive today. *Low, 1 verb.*
13. **Circuit-breaker on repeated dispatch failure.** `dispatch_contexts.failure_count`
    + `circuit_broken`. Stops a seat retrying forever. *Low, 0 verbs. Build regardless
    of scale.*

Convergence worth noting: Orca removes worktrees with `git branch -d`, never `-D`
(*"deleting a worktree must never silently discard commits"*). Patrol reached the same
rule independently in 0.2.6.

## DO NOT STEAL — additions

- **Orca's CLI breadth.** ~140 leaf commands: `emulator` (14), `computer` (12),
  `browser-basic` (~28), `browser-advanced` (~20), `linear` (18). That is an IDE
  replacing VS Code + Playwright + a Linear client. Patrol publishes 20 verbs so the
  number can be watched.
- **The task queue with dependency graph.** The most impressive thing Orca has —
  `tasks` with `deps` JSON and `pending→ready→dispatched→blocked`. Costs 4 verbs.
  Worth it only once seats actually idle for want of assignment. Not observed. Note it,
  do not build it.
- **"Any CLI binary in a terminal" as the backend contract.** The thinness that makes
  onboarding trivial is why Orca cannot support a generic OpenAI-compatible endpoint
  (open issue #9335). Steal the config table (#9), not the absence of a contract.
- **Worktree-persistence-by-default.** Orca's worktrees survive restarts and need
  explicit `rm` because its agents are IDE sessions a human sits in. A fleet that cycles
  worktrees far more often would leak disk.
- **Full-app headless.** See #3 above — Patrol already wins here.
- **Multi-account credential staging** → moved to WATCH. Real leverage against rate
  limits (N keychain credential sets, pointer swap, no re-auth) but it is OS-keychain
  surgery, and Orca's `#10757 "Chat history lost after account switch"` shows the
  failure mode.
- **SSH relay for remote seats** → WATCH, not steal. `src/main/ssh/ssh-relay-deploy.ts`
  (60KB, version-locked thin relay) is a far better model than `orca serve`, but Patrol
  is single-machine *by design* — a scope boundary, not a gap. Revisit only when a
  second machine actually needs a seat.

## The finding that outranks every competitor

`DESIGN.md:18` sets the reversal condition: *"Reverses if: Anthropic ships persistent
cross-session teams — then Patrol pivots to the launcher + cost-tracking layer on top of
native transport, and the broker retires."*

cmux now ships `cmux claude-teams` (PR #1179, maintained since), whose own locale string
reads: *"launches Claude Code with agent teams enabled. When Claude spawns teammate
agents, they appear as native cmux splits."* A 25k-star tool is building product surface
**on top of** first-party Agent Teams rather than around it.

**The reversal has NOT triggered.** Agent Teams remains session-scoped and lead-spawned,
exactly as `DESIGN.md:16-17` already recorded (Anthropic issue #28300 requests the
standing-seat model; unshipped). But the gap is narrowing and third parties are now
productising the first-party feature. **Issue #28300 is the tripwire.** Watch it more
closely than any tool in the matrix above.

## Method note for the next researcher

Three of this report's claims died because a sweep searched one vocabulary and a grep
read one file. Both failures look identical from inside: a confident negative produced
by stopping at the first plausible answer. When a claim is load-bearing — "nobody does
X" — the burden is to find the tool that does, not to fail to find one.

## Sources added (primary)
`gh api` for all metadata · depth-1 clones read first-hand: stablyai/orca,
jayminwest/overstory, manaflow-ai/cmux · ctx views.rs (unrelated, see r-recall) ·
github.blog Copilot app GA post · Orca issues #4280, #9335, #10757, #10775, #10904 ·
Anthropic issue #28300 (unverified in this pass — cited from DESIGN.md).
