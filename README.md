<div align="center">

<img src="assets/logo.png" alt="Claude-Patrol" width="160" />

# Claude-Patrol

**Run a fleet of Claude Code sessions like a team, and see what each one costs.**

[Why](#why-standing-seats) · [How you use it](#how-you-actually-use-it) · [Features](#what-patrol-does-that-raw-terminals-dont) · [Compare](#where-patrol-sits) · [Quickstart](#quickstart) · [Roadmap](#roadmap)

[![license](https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square)](LICENSE)
[![tests](https://img.shields.io/badge/tests-505%20passing-brightgreen?style=flat-square)](tests)
[![bun](https://img.shields.io/badge/Bun-1.2+-black?style=flat-square&logo=bun)](https://bun.sh)
[![typescript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](tsconfig.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-orange?style=flat-square)](#contributing)
[![buy me a coffee](https://img.shields.io/badge/buy%20me%20a%20coffee-FFDD00?style=flat-square&logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/alexcahiz)

</div>

---

It's four parts: an authenticated local broker, push messaging that coalesces
instead of spamming a session once per message, per-seat cost tracking, and a
launcher that boots each seat from a profile.

```bash
patrol up          # boot a whole fleet from patrol.yaml, one command
patrol status      # who's running, what role, what model, what it costs
patrol watch       # live TUI: fleet board + message log, across all projects
patrol send <id> "review the diff in ~/proj/x"
patrol down        # tear it all down
```

## Contents

- [Why standing seats](#why-standing-seats) — the one-paragraph case
- [How you actually use it](#how-you-actually-use-it) — **a day with a fleet, start to finish**
- [What Patrol does that raw terminals don't](#what-patrol-does-that-raw-terminals-dont) — the feature list
- [Where Patrol sits](#where-patrol-sits) — **honest competitor matrix, 26 tools**
- [Quickstart](#quickstart) — install and first fleet
- [Commands](#commands) — all 19 verbs
- [Architecture](#architecture) — how the parts wire together
- [Roadmap](#roadmap) — shipped and next ([full detail](ROADMAP.md))
- [Status and caveats](#status-and-caveats) — **what it does not do**
- [Contributing](#contributing) · [License](#license) · [Support](#support)

## Why standing seats

A seat that has been reviewing the same codebase for six waves is better at it than a
subagent spawned thirty seconds ago. It knows what was already ruled out, which
failure modes this repo actually has, and what "done" looks like here. That
continuity is the reason to run standing seats, and no pricing change can erode it —
a fresh agent starts from nothing regardless of what a token costs.

The second reason is that you can see what each one costs. Patrol reads Claude Code's
own session logs and attributes spend to a **named seat**, with subagent spend rolled
up to whoever spawned it, split across the three billing wallets that are actually
separate accounts. A handful of other tools track cost; see
[where Patrol sits](#where-patrol-sits) for exactly who, and how theirs differs.

Cost is the third reason, not the first — and it is the one most exposed to a vendor
changing the substrate underneath it. Here is the measurement anyway, with its limits
attached.

<div align="center">
<img src="assets/why-standing-seats.png" alt="Subagents $6.22 vs standing seats $2.16, a 65% cost cut" width="620" />
</div>

Measured on real workloads (July 2026, identical fixed-spec dev task, same
quality gate, cost from session logs at list prices). Config-matched: both runs
on the same plugin-heavy seat configuration.

| topology (plugin-heavy config) | cost | wall-clock |
|---|---|---|
| orchestrator + **subagents** (spawn per task) | $6.22 | 13m 15s |
| orchestrator + **standing peer seats** | **$2.16 (−65%)** | **5m 03s (−62%)** |

**The mechanism is context weight.** Every subagent spawn re-buys the seat's standing
context (system prompt, MCP schemas, CLAUDE.md) as cache *writes* — ~138k tokens per
spawn on a heavy config. A standing seat buys that once and reads it back at 1/12.5
the write price, amortizing after roughly one task.

So the cost driver is **config weight × spawn count**, and Patrol attacks both ends:
standing seats amortize the buy, per-seat profiles (`peer`, `lite`) shrink what gets
bought at all.

<details>
<summary><b>Three honest caveats on that number</b> (click — they matter)</summary>

1. **Small sample.** 1–2 runs per cell, and dollar totals are sensitive to the exact
   subagent mix. The robust, repeatable finding is the per-spawn cache-write re-buy,
   **not the headline percentage**. A repeat of the subagent run on a stripped-down
   orchestrator came in at $1.06 — about 80% of the heavy run's cost was config weight
   being repurchased per spawn, not the task itself.
2. **The vendor holds a lever we don't.** This is a fact about config weight. Cheaper
   cache reuse across spawns would shrink this gap without anyone changing Patrol.
3. **Standing seats have a cost this benchmark did not isolate.** An orchestrator idle
   while a seat works can let its own prompt cache expire, and the next turn re-encodes
   an unchanged history at the write rate. `patrol status` now measures that (`cache
   tax`) rather than assuming it away — but the benchmark predates the measurement, so
   treat that direction as **untested**.

Treat the dollar figure as directional. The continuity is the durable part.

</details>

## How you actually use it

The feature list below is long. This is the short version: **what a day with a fleet
looks like**, in the order you do it. Install steps are in [Quickstart](#quickstart).

### 1. Describe the team once

`patrol init` walks you through it and writes `patrol.yaml` (gitignored). You edit that
file when the team changes, and never again.

```yaml
seats:
  - { name: orchestrator, model: opus,   profile: full }   # your workhorse
  - { name: builder,      model: opus,   profile: peer }   # cheap, no plugins
  - { name: reviewer,     model: sonnet, profile: peer }
```

### 2. Boot the whole thing

```bash
patrol up          # every seat, its own tmux window, its own model and profile
patrol cockpit     # all of them in ONE window: big focus pane + live previews
```

You are now looking at real terminals, not a dashboard's summary of them.

### 3. Hand out work

```bash
patrol send builder "add rate limiting to the /upload route"
patrol send reviewer --brief specs/wave-3.md    # hands over a POINTER, not 4KB of text
```

> **Why `--brief` matters:** a pasted brief enters the seat's context once and is then
> re-billed on **every later turn** of that session. The pointer is read once.

### 4. Give a task its own branch

```bash
patrol worktree builder feat/rate-limit    # cuts an isolated git worktree, tells the seat
```

The seat is not pinned to that tree. It picks a task tree up and puts it down — which
is the whole difference between a standing seat and a per-task agent.

### 5. Watch without hovering

```bash
patrol status      # who's running, what state, what it costs, per wallet
patrol watch       # live TUI: fleet board + every message flowing between seats
patrol dash        # browser: question inbox, fleet board, audit log, working diffs
```

The **question inbox** is the one to know. A seat that hits an ambiguity calls `/ask`
instead of guessing or stalling; every open question lands in one place; you answer;
the broker routes the answer back to the seat that asked.

### 6. Land it

```bash
patrol wait builder --until done --timeout 600
patrol checkpoint builder --gate "bun test"
```

`checkpoint` quiesces the seat, runs your gate in the worktree, merges the branch back
to trunk inside a throwaway integration worktree, and removes the task tree. A failing
gate or a conflict **stops cleanly with trunk untouched** — you get `INCOMPLETE`, never
a false success.

### 7. Stop

```bash
patrol down        # this fleet only; other projects' fleets keep running
```

<details>
<summary><b>Running more than one project at once</b></summary>

Each `patrol.yaml` is a **fleet**, keyed by its git root, living in its own tmux session
(`patrol-<fleet>`). `patrol down` in one project cannot touch another's seats. Handles
are per-fleet, so two projects can both have a `builder`; reaching across requires an
explicit `other-fleet/builder`. Ports stay machine-global on purpose — they are a real
OS resource, and per-fleet ranges would hand two projects the same 9000.

</details>

## What Patrol does that raw terminals don't

**The 30-second version.** Each row links to its detail below.

| | what it means for you |
|---|---|
| [Fleet launcher](#1-one-command-n-pre-profiled-seats) | one file, one command, instead of ~10 manual steps per seat |
| [Boot guard](#2-a-hard-boot-guard) | a seat can't silently boot on an expensive model |
| [**Per-seat cost**](#3-per-seat-cost-tracking) | **you can see which teammate is burning your money** |
| [Coalesced wake-ups](#4-coalesced-wake-ups) | 5 messages cost 1 paid turn, not 5 |
| [Authenticated broker](#5-an-authenticated-broker-with-fenced-delivery) | random local processes can't inject text into your sessions |
| [Self-describing seats](#6-seats-that-describe-themselves) | route work by the seat list, no round-trip to ask |
| [`patrol watch`](#7-one-screen-for-the-whole-fleet) | one screen for every seat on the machine |
| [Codex seats](#8-codex-seats-a-standing-thread-not-a-fresh-subagent-per-task) | a standing GPT thread you message like a teammate |
| [Command center](#9-a-command-center-in-the-browser) | question inbox, fleet board, audit log, live diffs |
| [`patrol cockpit`](#10-one-window-instead-of-six) | six tmux windows folded into one |
| [Config wizard](#11-a-wizard-for-the-config) | `patrol init --ai` reads the repo and suggests the team |
| [Budget alerts](#12-budget-alerts-on-the-ledger-you-already-have) | a seat pings you when it crosses its cap |
| [**Worktree + checkpoint**](#13-a-worktree-per-task-not-per-seat) | **task branches that merge back without eating your work** |
| [State + `wait`](#14-seats-that-say-what-they-are-doing) | scripts can block on "done" instead of polling |

---

### 1. One command, N pre-profiled seats

> **In plain terms:** you write down your team once, then start all of them with a
> single command instead of opening six terminals and configuring each by hand.

`patrol up` reads `patrol.yaml` and boots each seat with its own model, role,
working dir, backend (tmux window or headless `claude --bg`), and boot profile,
including per-seat plugin subsets. That replaces about ten manual steps per fleet.

### 2. A hard boot guard

> **In plain terms:** Patrol refuses to start a seat you forgot to pick a model for,
> because that mistake costs about $4 before the seat does any work.

A seat cannot launch without an explicit model. Booting a seat on an expensive
default model costs real money before it does any work, measured at $3.6–4.9
per accidental boot, three times in one evening. Patrol refuses the launch instead.

### 3. Per-seat cost tracking

> **In plain terms:** you can see exactly which teammate is spending your money, live,
> broken out by which of your three separate bills it lands on.

`patrol status` shows live spend per seat, computed from Claude Code's own session
logs. Subagent spend rolls up to the seat that spawned it; leaving subagent
transcripts out undercounted real runs by 63% before we caught it. Every launched
seat carries a `[patrol-seat: cp-…]` token in its boot prompt, content-matched to
its session log, so ten seats working in one repo each get their own number rather
than a shared guess. The history lives in a SQLite ledger that survives seat
teardown and broker restarts. As of v0.2.4 that spend is split across three billing
wallets: the interactive subscription, the Agent-SDK credit pool (`claude -p`
seats), and external (codex). Reported separately, never summed, because they bill
different accounts.

Cost tracking is **not** unique to Patrol — see [where Patrol sits](#where-patrol-sits)
for who else has it and how theirs differs.

<div align="center">
<img src="assets/billing-pools.png" alt="Three billing wallets (subscription, agent-sdk, external), never summed" width="620" />
</div>

### 4. Coalesced wake-ups

> **In plain terms:** if five messages arrive while a seat is busy, it wakes up once
> and reads all five — instead of waking five times and charging you for each.

Every push notification wakes the receiving session for a full turn at full context
price. Patrol delivers each poll batch as one notification, however many messages
queued, so N messages never cost N turns.

### 5. An authenticated broker with fenced delivery

> **In plain terms:** nothing else on your machine can slip text into your Claude
> sessions pretending to be a teammate — and a message can't lie about who sent it.

Without auth, any local process can POST text into your Claude sessions framed as a
teammate. Patrol gates the broker with a 0600 shared-secret file (symlink, owner,
and permission checks on every read) and validates every request's shape and size.
Each delivered message body is wrapped in a per-notification random fence, so a body
cannot forge a `[from …]` header or borrow another seat's authority.

### 6. Seats that describe themselves

> **In plain terms:** every seat announces its role and model when it starts, so your
> orchestrator can hand work to the right one without asking around first.

Role, model, and profile ride along at registration (`CLAUDE_PATROL_*` env, set by
the launcher). Orchestrators route work by the seat list instead of burning a
round-trip asking every seat what it runs.

### 7. One screen for the whole fleet

> **In plain terms:** one window showing every seat on your machine and every message
> between them, with a box to type into.

`patrol watch` is a live TUI: every seat on the machine (whatever project it sits
in), a running log of the messages flowing between them, and a send bar. Tab picks
a target, Enter messages it. Fleet operation stops meaning six tmux windows and a
prayer.

### 8. Codex seats: a standing thread, not a fresh subagent per task

> **In plain terms:** you get a GPT teammate that remembers the codebase between
> questions, instead of one that re-reads everything from scratch every time.

`backend: codex` boots an adapter that registers as an ordinary seat and keeps one
`codex exec resume` thread alive behind it. You message it like any other seat and
it answers from the context that thread has already built. The usual way to reach
codex from an agent is to spawn it per task, which re-explores the repo on every
run; a standing thread pays for that once. Turns are serialized, so the thread stays
coherent, and it retires itself once its resent prefix crosses a billed-token budget
(default 300k). Two limits worth knowing before you rely on it: codex writes no
Claude Code session log, so a codex seat shows no spend in `patrol status` (absent,
not misattributed), and a reply over the broker's 8KiB cap arrives truncated with a
path to the full text on disk.

### 9. A command center in the browser

> **In plain terms:** one browser page where you answer your seats' questions, watch
> the team, read every message they've sent each other, and see what they've changed.

`patrol dash` opens a broker-served page with four panes: a **question inbox** (a
seat asks with `/ask`, every open question surfaces in one place, you answer, the
broker routes the answer back to the asking seat as a message), the fleet board
with live seat state, a comms audit log of every message that crossed the broker,
and a per-seat working-diff pane (tracked and untracked, capped at 256 KiB) plus
the three-wallet billing strip. It is served on loopback only, and `patrol dash`
mints a short-lived nonce for it: that nonce authenticates the read routes and
`/answer` and nothing else. Every write route still requires the full secret, so a
leaked nonce cannot spoof a seat, send messages, or destroy another seat's mail.

### 10. One window instead of six

> **In plain terms:** stop alt-tabbing between six terminals. One window, one big pane
> for whoever you're focused on, small live views of everyone else.

`patrol cockpit` folds the fleet into a single tmux window: a big focus pane over
tiled live previews of every other seat, `Ctrl-b z` to zoom one fullscreen, `Ctrl-b
P` to promote a preview into the focus pane, key hints in the status bar. These are
the real terminals joined in, not a summary of them, and each seat's live process is
preserved.

### 11. A wizard for the config

> **In plain terms:** you don't have to learn the config file. Answer some questions —
> or let it read your repo and suggest a team for you.

`patrol init` walks you through a fleet and writes a validated, gitignored
`patrol.yaml`. `patrol init --ai` runs a one-shot `claude -p` over the repo and your
stated goal and recommends the seats. That run is isolated on purpose: empty MCP
config, no tools, a temp cwd so no project `CLAUDE.md`, settings, or hooks load, and
repo signals fenced as untrusted data, so a hostile repo cannot steer it.

### 12. Budget alerts on the ledger you already have

> **In plain terms:** set a spending cap per seat. When one crosses it, you get told
> once. It never cuts the seat off — that stays your call.

Give a seat (or the whole fleet) a `budget_usd`, and the seat that crosses it pings
`budget_alert_to` (by default the `orchestrator`-role seat) exactly once. It is
observe-only: Patrol reports spend, it never gates the model or stops a seat.
`patrol status` grows a `BUDGET` column and an `OVER` marker. The check runs in an
isolated try inside the cost tick, so a bug in it cannot break cost indexing.

### 13. A worktree per task, not per seat

> **In plain terms:** each job gets its own branch and its own copy of the code, so two
> seats never trip over each other. When the job is done, one command merges it back —
> and if anything looks wrong, it stops rather than guessing.

`patrol worktree <seat> <branch>` cuts a tracked git worktree under
`.claude/worktrees/` and tells the seat where it is; `patrol checkpoint <seat>
[--gate "<cmd>"]` runs the gate there, merges the branch back to trunk, and removes
the worktree. The seat itself is never pinned to a tree; it is a standing seat that
picks up a task tree and puts it down. The merge-back runs inside a throwaway
integration worktree, so it never mutates a checkout another seat may be mid-build
in; git's one-branch-one-worktree rule refuses if trunk is live, a conflict STOPs
with the trunk ref untouched, and the seat's tree is removed without `--force` so
uncommitted work is preserved rather than destroyed. See
[the checkpoint caveat](#status-and-caveats) for what a lease does and does not
cover.

### 14. Seats that say what they are doing

> **In plain terms:** seats tell you whether they're working, stuck, or finished — so a
> script can wait for "done" instead of you checking on them.

A seat self-reports `idle | working | blocked | done`, so `patrol wait builder
--until done --timeout 300` replaces hand-polling in a script. Seats also carry
readable handles assigned at register (`patrol send builder`, `patrol rename <old>
<new>`); the immutable id stays the internal key and a fallback.

## Why a codex seat is set up the way it is

<div align="center">
<img src="assets/codex-safety.png" alt="Three nested safety layers: read-only sandbox, command-veto hook, message fence" width="600" />
</div>

A codex seat is a standing process that acts on messages from other seats,
sometimes while no one is watching. Codex can edit and run commands, so an
over-trusting setup is one bad instruction away from a deleted tree or a force
push. The seat is built so that no single mistake (a poisoned message, a
model that misreads its role) can cause that. Three independent layers, and
any one of them stops the damage:

**1. Read-only by default.**

> **In plain terms:** a codex seat can't touch a single file unless you said so in
> writing, in the config. Nothing it's told at runtime can change that.

A codex seat cannot change files unless its `patrol.yaml` entry explicitly asks for it
(`sandbox: workspace-write`). A seat you spun up to answer questions has no way to
write, full stop. The sandbox flag is set by the launcher, not the message, so a sender
cannot talk the seat into escalating its own permissions, because **the model never
controls its own command line**. `workspace-write` also confines writes to the seat's
working directory, so even a write seat cannot reach outside its repo.

**2. A command veto for write seats.**

> **In plain terms:** even a seat that's allowed to write still can't run the genuinely
> destructive commands. A separate gate checks every command and refuses those.

Sandbox mode decides *where* writes can land; it does not decide *which* commands run.
So a write-enabled seat also runs a Patrol-authored `PreToolUse` hook that codex
consults before every command and can deny, the same mechanism Claude Code uses.
Destructive verbs (recursive force-deletes, force pushes, history rewrites, piping the
network into a shell, writes redirected outside the workspace) are refused before they
execute. Verified against the real codex binary on 2026-07-14: with writes enabled
**and hook-trust bypassed**, the hook still blocked a file write. The veto holds
regardless of what the model decides to do.

**3. The message is data, not orders.**

> **In plain terms:** another seat can ask this one to do work. It cannot talk it into
> changing its own rules — the message is quoted material, not a command.

The inbound message body is fenced as untrusted content, exactly as it is for Claude
seats, with an instruction that nothing inside it changes the seat's role, sandbox, or
safety rules. A sender can ask the seat to do work; it cannot rewrite what the seat is
allowed to do.

The honest limit: a codex seat still shows no spend in `patrol status` (it
writes no Claude Code session log; surfacing codex's own usage is a later
item), and reading its usage into the cost ledger is on the roadmap below.

## Where Patrol sits

This is a crowded field and Patrol is one of the smaller entries in it. The numbers
below are from `gh api`, not scraped pages, and every capability claim was checked
against a file in a clone rather than a README. Full workings and sources:
[`research/r4-competitive-landscape-2026-07.md`](research/r4-competitive-landscape-2026-07.md).

**Start with what is not ours.** A sweep on 2026-07-27 killed three claims this
project had been making, one of them on this page:

- ❌ *"No competitor tracks per-seat cost."* **False.** `coder/mux` has a Costs tab,
  `agent-deck` reads Claude Code transcripts for per-session dollars, claude-flow ships
  a cost-tracker with budget alerts, and Claude Swarm has `ps`/`show`.
- ❌ *"No competitor covers Patrol's full stack."* **False.** `jayminwest/overstory`
  built the same architecture — message table, per-agent cost with subagent rollup,
  YAML config — independently, in February 2026. It was **archived in May**. The
  closest architectural twin Patrol has died in three months. That is a warning about
  the category, not a moat.
- ❌ *"Don't build a GUI, crystal had to retreat from Electron."* **Misreading.**
  Crystal's successor is a *larger* Electron app plus native mobile, and both GitHub and
  OpenAI shipped desktop apps for this category in 2026.

### The field, by size

Star counts verified 2026-07-27. **Bold = Patrol leads on that axis.**

| tool | ★ | what it is | seat↔seat comms | cost per seat | local merge-back |
|---|---:|---|---|---|---|
| stablyai/orca | 30.1k | vendor-neutral agent ADE, desktop + mobile | ✅ pty injection, 15 verbs | ⚠️ $ by model/project/run, not by agent | ❌ punts to `gh pr merge` |
| vibe-kanban | 27.5k | worktree + kanban board | ⚠️ implicit via board | ❌ | ⚠️ PR-gen |
| manaflow-ai/cmux | 25.2k | Ghostty-fork terminal for agents | ❌ | ⚠️ per-turn echo | ❌ |
| superset-sh/superset | 12.6k | "code editor for AI agents", 12 backends | ❌ | ❌ | ❌ |
| herdr | ~11k ? | TUI multiplexer, auto-state sidebar | ✅ unix socket | ❌ | ❌ |
| AgentWrapper/agent-orchestrator | 8.6k | 23 backend adapters, desktop | ❌ | ❌ | ❌ |
| claude-squad | 8.2k | worktree + TUI + diff pane | ❌ | ❌ | ⚠️ |
| container-use | 3.9k | Docker-per-agent substrate | ❌ | ❌ | ❌ |
| agent-of-empires | 2.9k | TUI + web/mobile, tmux + worktree | ❌ | ❌ | ❌ |
| AgentsMesh | 2.3k | "AgentPod" per agent, channels + @mentions | ✅ | ? | ❌ |
| coder/mux | 1.9k | desktop + browser, local/worktree/SSH | ❌ | ✅ per-agent | ❌ |
| jayminwest/overstory | 1.3k | **archived 2026-05** — Patrol's twin | ✅ | ✅ per-agent + rollup | ⚠️ |
| nimbalyst | 1.3k | crystal's successor, GUI + mobile | ❌ | ❌ | ⚠️ |
| ccmanager | 1.2k | worktree + TUI, status hooks | ❌ | ❌ | ⚠️ |
| asheshgoplani/agent-deck | 605 | TUI fleet manager | ⚠️ orchestrator-relayed | ✅ per-session | ❌ |
| uzi | 579 | worktree + tmux + auto port alloc | ⚠️ one-way broadcast | ❌ | ✅ `checkpoint` |
| **Claude-Patrol** | — | **broker + launcher + cost ledger** | **✅ coalesced push** | **✅ per-seat, 3 wallets** | **✅ fenced + quiesced** |

Plus the orchestration frameworks, which are a different weight class: **claude-flow /
ruflo** (blackboard comms, cost-tracker with budget alerts, and a tool count its own
docs give as 87, 171, *and* 210 in three places) and **Claude Swarm** (filesystem
isolation, MCP point-to-point `task`, and `ps`/`show` costs — but its own docs admit
the **main instance's cost is untracked**, which is usually the most expensive seat).

### What actually survives as Patrol-only

Stated narrowly, because the wide version was wrong:

1. **Cost attributed to a named standing seat**, with subagent rollup and the
   three-wallet split. Orca has dollars but bins them by model, project, and run — it
   never joins them to the agent handles its own coordinator addresses. Overstory did
   join them, and is archived.
2. **Local merge-back.** `checkpoint` — throwaway integration worktree, three fences, a
   quiescing lease, `INCOMPLETE` over false success — has no counterpart in the largest
   tool in the field. Orca's `git merge` appears only to detect a conflict and `--abort`
   it; landing goes through GitHub's web UI.
3. **A lean headless broker.** Orca's `orca serve` is the full Electron app under Xvfb,
   and its top-voted open issue is #4280, *"First-class headless / server mode"*.
   Patrol's broker is a Bun process with no GUI dependency.

### Where others beat us, plainly

- **Maturity and testing surface.** Patrol is one person on one machine. Orca, cmux and
  superset have orders of magnitude more users finding their bugs.
- **Vendor neutrality.** superset ships 12 backends and agent-orchestrator 23; Patrol
  has four and each costs a hand-written adapter.
- **Isolation.** container-use gives each agent a real Docker container. A git worktree
  is a much weaker boundary.
- **Interface.** If you want a polished desktop or mobile app, several of these have one
  and Patrol has a TUI and a loopback web page.
- **Delivery robustness.** Orca's pty keystroke injection works on any terminal agent.
  Patrol's push rides `claude/channel`, a Claude Code research preview.

### Head to head: the ancestor

Patrol is a ground-up rewrite informed by running
[claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) in anger, and
patching it. Several Patrol features were prototyped there first.

| | claude-peers-mcp (0.1.0) | Claude-Patrol |
|---|---|---|
| MCP surface per seat | 4 tools (send/list/summary/check) | 2 tools (summary/check); send/list/status are CLI verbs, near-zero schema payload |
| Push notifications | one per message → N messages = N paid wake-ups | **coalesced: one per poll batch** |
| Sender context | extra `list-peers` call per inbound message | joined by the broker at poll time |
| Broker auth | none; any local process can inject messages | shared-secret token, 0600 file |
| Seat identity | id + cwd | + role, model, profile (self-describing fleet) |
| Cost tracking | none | **per-seat live spend, subagent transcripts included** |
| Fleet launcher | none; open terminals by hand | `patrol up`: yaml config, tmux + headless backends, per-seat plugin subsets |
| Boot safety | boots on default model (measured $3.6–4.9/accident) | model required per seat, validated before launch |
| Deregistration | process exit only | SessionEnd hook + idempotent `/unregister` (by id or pid) + stale-PID sweep |
| Boot latency | LLM auto-summary API call (up to 3s, external dep) | opt-in only; seats self-describe |
| Message table | grows forever | delivered messages purged after 7 days |
| Packaging | manual clone + .mcp.json | Claude Code plugin (commands, skill, hook, MCP) + CLI/daemon |
| Tests | none | 505 across broker, costs, launcher, CLI, codex adapter, integration |

## Quickstart

**Requirements:** [Bun](https://bun.sh) ≥1.2, Claude Code ≥2.1.80 (logged in via
claude.ai, not an API key), tmux for visible seats, macOS or Linux.

Full step-by-step with a verification per step: **[SETUP.md](SETUP.md)**. The short
version:

```bash
git clone https://github.com/AMPMIO/Claude-Patrol.git && cd Claude-Patrol
bun install && bun link
cp patrol.yaml.example patrol.yaml   # edit seats
patrol up
patrol status
patrol watch                          # live fleet board + message log
```

`patrol.yaml`:

```yaml
seats:
  - name: orchestrator
    model: opus
    profile: full          # everything on, the long-lived workhorse
  - name: builder
    model: opus
    profile: peer          # no plugins, patrol MCP only; cheap seat
  - name: scout
    model: sonnet
    backend: bg            # headless via `claude --bg`; see the caveat below
    profile: peer
    prompt: "You are a research scout. Await tasks via patrol."
  - name: cx
    model: gpt-5.6-terra
    backend: codex         # standing codex thread, messaged like any seat
    prompt: "You are the codex seat. Answer from the thread's accumulated context."
```

> [!WARNING]
> A `bg` seat registers and shows up in `patrol status`, but it never receives
> message pushes: the development-channels flag sits behind an interactive consent
> gate a headless session cannot answer. Use `tmux` (or `codex`) for anything
> message-driven; `bg` is for seats that only need to exist.

**Profiles:** `lite` (no plugins, no MCP), `peer` (no plugins + patrol seat server),
`full` (inherit everything), or an inline map with a per-seat plugin subset:

```yaml
    profile:
      plugins: [codex, superpowers]   # just these two
      mcp: patrol
```

`patrol init` writes a validated `patrol.yaml` for you (and gitignores it);
`patrol init --ai` reads the repo and your stated goal and recommends the seats.

## Commands

Nineteen verbs, and the number is published so it can be watched. See
[Command surface](#roadmap) for why. `patrol` with no arguments prints the same
list.

| verb | what it does |
|---|---|
| `patrol init [--ai]` | wizard: write a `patrol.yaml` here (`--ai` for AI-suggested defaults) |
| `patrol up [config]` | launch the fleet from `patrol.yaml` |
| `patrol down` | tear the fleet down |
| `patrol status` | fleet board: seats, roles, models, state, spend, budget |
| `patrol send <handle> <msg>` | message a seat (handle or id) |
| `patrol list` | list seats, compact |
| `patrol rename <handle> <name>` | rename a seat's handle |
| `patrol wait <handle> --until done[,blocked]` | block until a seat reaches a state (`--timeout 300`) |
| `patrol doctor` | check broker/daemon health |
| `patrol stats` | telemetry: wake-ups, coalescing ratio, attribution layers |
| `patrol watch` | live TUI: fleet board + message log across projects |
| `patrol cockpit` | fold the fleet into one tmux window: focus pane + tiled previews |
| `patrol dash` | open the command-center dashboard in your browser |
| `patrol claim-port <id> [n]` | allocate n ports to a seat from the range |
| `patrol claim <id> <path>...` | claim paths for a seat (advisory) |
| `patrol claims [git-root]` | list current path claims |
| `patrol release <id> [path...]` | release a seat's path claims |
| `patrol worktree <seat> <branch> [--base <ref>]` | cut a task worktree for a seat |
| `patrol checkpoint <seat> [--gate "<cmd>"] [--force]` | merge the branch back, remove the worktree |

## Architecture

<div align="center">
<img src="assets/architecture.png" alt="One broker, N seats, a shared SQLite ledger, messages on a bus between them" width="760" />
</div>

One authenticated broker at the center; every seat registers with it, and messages
flow seat-to-seat across it. The precise wiring:

```
┌─ terminal 1 ─┐  ┌─ terminal 2 ─┐  ┌─ headless ──┐
│ claude       │  │ claude       │  │ claude --bg │
│  └ seat-srv ─┼──┼─ seat-srv ───┼──┼─ seat-srv ──┼──► broker (:7900)
└──────────────┘  └──────────────┘  └─────────────┘    ├ SQLite
        ▲                ▲                             ├ auth token
        └── channel push ┘        patrol CLI ──────────┤ /costs ◄─ session logs
                                  (send/list/status)   └ stale-PID sweep
```

- **Broker**: singleton localhost daemon, SQLite, auto-started by the first seat.
  All POSTs authenticated.
- **Seat server**: minimal stdio MCP per session: registers, polls, pushes coalesced
  `claude/channel` notifications. Everything else is the CLI.
- **Costs**: a background indexer parses `~/.claude/projects` session logs into an
  hour-bucketed SQLite ledger. Attribution tries the launch-token content match
  first, then the SessionStart hook, then a window heuristic that reports
  "unattributed" rather than guess wrong.

## Roadmap

Sequenced, not parallel: each version has to prove itself in real use before the next
starts. **No dates.**

**Full detail on every release and everything planned: [`ROADMAP.md`](ROADMAP.md).**
Line-item changes: [`CHANGELOG.md`](CHANGELOG.md).

### Shipped

| version | in one line |
|---|---|
| **v0.2.0** | The rewrite: authenticated broker, coalesced push, three-layer cost attribution, launcher. |
| **v0.2.2** | Codex seats — one standing `codex exec resume` thread behind an ordinary seat. |
| **v0.2.3** | Lease/ack delivery, so a failed push stops silently dropping work. Codex seats hardened to three layers. |
| **v0.2.4** | Headless backend, the **three billing wallets**, port + path claims, seat state + `wait`, readable handles. |
| **v0.2.5** | `patrol dash` (question inbox, fleet board, audit log), `patrol cockpit`, `patrol init [--ai]`. |
| **v0.2.6** | Budget alerts; `patrol worktree` + `patrol checkpoint` — the task-worktree loop in two verbs. |
| **v0.2.7** | Eight adversarial-review findings. The critical one: `GET /dashboard` was unauthenticated **and embedded the broker secret in the page**. |
| **v0.2.8** | A review of 0.2.7's own fixes. Three were incomplete; one was a regression it introduced. |
| **v0.2.9** | Checkpoint stops *racing* the seat and **quiesces** it instead — detection cannot win a race against a concurrent writer. |
| **v0.3.0** | **Identity.** Fleets (multi-project without cross-contamination), per-seat capability tokens, crash redelivery, `send --brief`. |

> **Command surface, held deliberately: 19 verbs.** The field's cautionary tale is a
> competitor whose own docs give its tool count as 87, 171, and 210. A small,
> memorizable set is the edge, so the number is published here to be watched. Several
> good ideas are deferred purely on this basis, and that is recorded rather than hidden.

### Next

Tracked as issues in the CLAP project; the themes, in rough priority order:

1. **Prove the guard fired.** `guarded` shows a hook is *installed*, never that it
   *ran*. Largest remaining gap in the checkpoint lease.
2. **Delivery that doesn't depend on a research preview.** A PTY-injection fallback, so
   `claude/channel` changing cannot break messaging.
3. **Rate-limit headroom in `patrol status`.** On a subscription, dollars are the wrong
   unit — the real question is *when does this seat get cut off*.
4. **Continuity across a restart.** `patrol recall` hands a returning seat its own prior
   session ids (pointers only, never injected transcripts).
5. **Real containment.** Per-seat OS users or a peer-credential unix socket. See the
   caveat below for why the current boundary is not this.
6. **Project-level telemetry**, schema-first and local-only — the honest way to test
   Patrol's own thesis rather than resting on one benchmark.

**v0.4, after it has proven itself:** a Rust CLI; SSE or long-poll replacing the 1s
poll; codex cost parsing; a ledger retention sweep; per-task cost tags; a Warp backend.

## Status and caveats

**v0.3.0, 505 tests.** Cost attribution survives the case that broke it in v0.1:
several seats working in the same repo, split across three billing wallets, with a
per-seat budget alert when one crosses its cap. History survives seat teardown and
broker restarts. `/costs` reads from an incrementally indexed ledger instead of
walking every log on request. Delivery leases and acks each message, so a failed
push doesn't drop a live seat's mail. Port and file-ownership claims keep parallel
seats from colliding; `patrol worktree`/`checkpoint` give each task an isolated
worktree and a safe merge-back. Codex seats default to a read-only sandbox behind a
command-veto hook. Delivered messages are fenced against header forgery, and every
broker request is validated.

This is a tool I built for my own fleet and then opened up. It is used daily, but by
one person on one machine, so expect sharp edges outside that path.

- **Single-machine by design.** No cross-host coordination, no hosted backend, no
  remote seats. This is not a limitation waiting to be lifted; it is the scope.
- **`checkpoint` quiesces tool calls, not processes.** The lease works through the
  seat's `PreToolUse` guard hook, so it stops the seat's next *tool call*. A tool
  call already in flight when the lease lands still completes (checkpoint waits it
  out and proves the tip has settled), and a background process the seat started
  earlier (a dev server, a watcher, a long build) keeps running and can still
  write. A seat with no guard hook cannot be quiesced at all, which is why
  `checkpoint` refuses an adapter seat (`codex`, `headless`) unless you pass
  `--force` and accept the older fences-only behavior.
- **`guarded` proves a hook is installed, not that it fired.** At registration a seat
  verifies what it can see locally: the lease path is absolute, the guard script
  exists, the lease directory is writable. It cannot verify that Claude loaded the
  settings overlay, that it will invoke the hook, or that it will honor the deny —
  only the seat's own session knows that, and it has no channel to say so. Closing
  this needs the hook itself reporting back that it ran. That handshake is the
  largest remaining gap in the lease, and it is not built. `checkpoint`'s three
  fences stay in place precisely as the detector for everything the lease cannot
  cover: if a fence trips, the lease failed, and you get `INCOMPLETE` rather than a
  false success.
- **The per-seat capability boundary does NOT contain a compromised seat.** Every seat
  authenticates with its own capability token, so the broker confines it to its own fleet
  and to a per-seat route allowlist — and since v0.3.0 that holds on the path seats are
  actually told to use, the `patrol` CLI they run through Bash. What that buys is real but
  bounded: it stops accidental cross-fleet action, it constrains adapter seats and any
  caller without a shell, and it makes a seat's messages provably come from that seat. It
  is not containment. A seat with Bash can read `~/.claude-patrol.secret` directly — same
  user, mode 0600 — and that secret is the operator credential, so a seat that wants
  operator scope simply takes it. No amount of CLI plumbing changes that. Real containment
  requires the secret to be unreadable by seats: per-seat OS users, or replacing the TCP
  listener with a unix socket authenticated by peer credentials. Both are roadmapped
  (v0.4); neither is shipped. Treat a seat as holding operator authority on this machine.
- **Operator verbs now refuse when a seat runs them.** The flip side of the above: with the
  CLI authenticating as the seat, `patrol checkpoint <other-seat>`, `patrol stats` and
  `patrol dash` are refused for a seat, and `patrol status` renders its board with the spend
  column blank (fleet-wide spend is the operator's view). The error names the cause and the
  fix — run it from your own shell. `send`, `list`, `status`, and everything about the
  seat's own row keep working unchanged.
- **The dashboard is loopback-only, and its token is scoped.** `patrol dash` mints
  a short-lived nonce that authenticates the read routes and `/answer`; every write
  route still requires the full broker secret, and the page is refused without a
  loopback `Origin`/`Host`. It is not an interface to expose off the machine.
- **A codex seat shows `—` in the SPEND column, not `$0`.** Codex writes no Claude Code session log, so
  there is no spend to attribute. The figure is absent rather than misattributed;
  parsing codex's own usage is a v0.4 item.
- **`ports:` in `patrol.yaml` is accepted but not yet delivered to the seat.** The
  broker allocates from the range, but nothing exports the result into a seat's
  environment. Use `patrol claim-port <seat> <n>` and pass the ports yourself.
- **The `claude/channel` capability is a Claude Code research preview**
  (`--dangerously-load-development-channels`). If it changes, delivery degrades to
  the `check_messages` fallback rather than breaking.
- **Reversal condition, stated up front:** if Anthropic ships persistent
  cross-session agent teams, Patrol's broker retires and the launcher + cost layer
  live on. That is written into `DESIGN.md`, not hidden.

Design decisions with kill criteria: [`DESIGN.md`](DESIGN.md). Research evidence:
[`research/`](research). Release notes: [`CHANGELOG.md`](CHANGELOG.md).

## Contributing

Issues and PRs are welcome, especially bug reports from a second machine. That is
the coverage I cannot give it myself.

```bash
bun install
bun test              # 505 tests
bunx tsc --noEmit     # strict, must stay clean
```

Both must pass before a PR merges. New logic ships with the smallest check that fails
if it is wrong. If you are changing behaviour rather than fixing a bug, open an issue
first so we can agree on the shape.

## License

[AGPL-3.0](LICENSE). Use it, fork it, run it, sell it. If you distribute a modified
version, or run one as a network service, publish your source. In plain terms: you
cannot take this closed.

## Support

If Patrol saved you a few dollars of tokens, you can send one back.

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/alexcahiz)
