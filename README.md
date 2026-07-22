<div align="center">

<img src="assets/logo.png" alt="Claude-Patrol" width="160" />

# Claude-Patrol

**Run a fleet of Claude Code sessions like a team — and see what each one costs.**

[Why](#why-standing-seats) · [Features](#what-patrol-does-that-raw-terminals-dont) · [Quickstart](#quickstart) · [Architecture](#architecture) · [Roadmap](#roadmap) · [Contributing](#contributing)

[![license](https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square)](LICENSE)
[![tests](https://img.shields.io/badge/tests-189%20passing-brightgreen?style=flat-square)](tests)
[![bun](https://img.shields.io/badge/Bun-1.2+-black?style=flat-square&logo=bun)](https://bun.sh)
[![typescript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](tsconfig.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-orange?style=flat-square)](#contributing)
[![buy me a coffee](https://img.shields.io/badge/buy%20me%20a%20coffee-FFDD00?style=flat-square&logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/alexcahiz)

</div>

---

An authenticated local broker, coalesced push messaging between independent
terminal sessions, per-seat cost tracking, and a profile-aware fleet launcher.

```bash
patrol up          # boot a whole fleet from patrol.yaml — one command
patrol status      # who's running, what role, what model, what it costs
patrol watch       # live TUI: fleet board + message log, across all projects
patrol send <id> "review the diff in ~/proj/x"
patrol down        # tear it all down
```

## Contents

- [Why standing seats](#why-standing-seats)
- [What Patrol does that raw terminals don't](#what-patrol-does-that-raw-terminals-dont)
- [Comparison: Claude-Patrol vs claude-peers-mcp](#comparison-claude-patrol-vs-claude-peers-mcp)
- [Quickstart](#quickstart)
- [Architecture](#architecture)
- [Roadmap](#roadmap)
- [Status and caveats](#status-and-caveats)
- [Contributing](#contributing)
- [License](#license)
- [Support](#support)

## Why standing seats

Spawning a subagent per task is the default way to run multiple agents. It is
also the expensive way, and we measured how expensive.

Measured on real workloads (July 2026, identical fixed-spec dev task, same
quality gate, cost from session logs at list prices). Config-matched: both runs
on the same plugin-heavy seat configuration.

| topology (plugin-heavy config) | cost | wall-clock |
|---|---|---|
| orchestrator + **subagents** (spawn per task) | $6.22 | 13m 15s |
| orchestrator + **standing peer seats** | **$2.16 (−65%)** | **5m 03s (−62%)** |

The mechanism is context weight. Every subagent spawn re-buys the seat's
standing context (system prompt, MCP schemas, CLAUDE.md) as cache *writes*:
~138k tokens per spawn on the heavy config against ~36k on a minimal one. A
repeat of the subagent run on a stripped-down orchestrator came in at $1.06, so
about 80% of the heavy run's cost was config weight being repurchased per spawn
and re-read per turn, not the task itself. A standing seat buys its context once
and reads it back at 1/12.5 the write price, amortizing after roughly one task.

Two honest caveats: sample sizes are 1–2 runs per cell, and dollar totals are
sensitive to the exact subagent mix. The robust, repeatable number is the
per-spawn cache-write re-buy. So the cost driver is config weight × spawn count,
and Patrol attacks both ends: standing seats amortize the buy, and per-seat
profiles (`peer`, `lite`) shrink what gets bought at all.

## What Patrol does that raw terminals don't

**1. One command, N pre-profiled seats.**
`patrol up` reads `patrol.yaml` and boots each seat with its own model, role,
working dir, backend (tmux window or headless `claude --bg`), and boot profile,
including per-seat plugin subsets. That replaces about ten manual steps per fleet.

**2. A hard boot guard.**
A seat cannot launch without an explicit model. Booting a seat on an expensive
default model costs real money before it does any work — measured at $3.6–4.9
per accidental boot, three times in one evening. Patrol refuses the launch instead.

**3. Per-seat cost tracking, the feature no peer tool has.**
`patrol status` shows live spend per seat, computed from Claude Code's own session
logs. Subagent spend rolls up to the seat that spawned it; leaving subagent
transcripts out undercounted real runs by 63% before we caught it. Every launched
seat carries a `[patrol-seat: cp-…]` token in its boot prompt, content-matched to
its session log, so ten seats working in one repo each get their own number rather
than a shared guess. The history lives in a SQLite ledger that survives seat
teardown and broker restarts.

**4. Coalesced wake-ups.**
Every push notification wakes the receiving session for a full turn at full context
price. Patrol delivers each poll batch as one notification, however many messages
queued, so N messages never cost N turns.

**5. An authenticated broker with fenced delivery.**
Without auth, any local process can POST text into your Claude sessions framed as a
teammate. Patrol gates the broker with a 0600 shared-secret file (symlink, owner,
and permission checks on every read) and validates every request's shape and size.
Each delivered message body is wrapped in a per-notification random fence, so a body
cannot forge a `[from …]` header or borrow another seat's authority.

**6. Seats that describe themselves.**
Role, model, and profile ride along at registration (`CLAUDE_PATROL_*` env, set by
the launcher). Orchestrators route work by the seat list instead of burning a
round-trip asking every seat what it runs.

**7. One screen for the whole fleet.**
`patrol watch` is a live TUI: every seat on the machine (whatever project it sits
in), a running log of the messages flowing between them, and a send bar — Tab picks
a target, Enter messages it. Fleet operation stops meaning six tmux windows and a
prayer.

**8. Codex seats: a standing thread, not a fresh subagent per task.**
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

### Why a codex seat is set up the way it is (v0.2.3)

A codex seat is a standing process that acts on messages from other seats,
sometimes while no one is watching. Codex can edit and run commands, so an
over-trusting setup is one bad instruction away from a deleted tree or a force
push. The seat is built so that no single mistake — a poisoned message, a
model that misreads its role — can cause that. Three independent layers, and
any one of them stops the damage:

1. **Read-only by default.** A codex seat cannot change files unless its
   `patrol.yaml` entry explicitly asks for it (`sandbox: workspace-write`). A
   seat you spun up to answer questions has no way to write, full stop. The
   sandbox flag is set by the launcher, not the message — so a sender cannot
   talk the seat into escalating its own permissions, because the model never
   controls its own command line. `workspace-write` also confines writes to
   the seat's working directory, so even a write seat cannot reach outside its
   repo.

2. **A command veto for write seats.** Sandbox mode decides *where* writes can
   land; it does not decide *which* commands run. So a write-enabled seat also
   runs a Patrol-authored `PreToolUse` hook that codex consults before every
   command and can deny — the same mechanism Claude Code uses. Destructive
   verbs (recursive force-deletes, force pushes, history rewrites, piping the
   network into a shell, writes redirected outside the workspace) are refused
   before they execute. We verified this against the real codex binary on
   2026-07-14: with writes enabled and hook-trust bypassed, the hook still
   blocked a file write — the veto holds regardless of what the model decides
   to do.

3. **The message is data, not orders.** The inbound message body is fenced as
   untrusted content, exactly as it is for Claude seats, with an instruction
   that nothing inside it changes the seat's role, sandbox, or safety rules. A
   sender can ask the seat to do work; it cannot rewrite what the seat is
   allowed to do.

The honest limit: a codex seat still shows no spend in `patrol status` (it
writes no Claude Code session log — surfacing codex's own usage is a later
item), and reading its usage into the cost ledger is on the roadmap below.

## Comparison: Claude-Patrol vs claude-peers-mcp

Patrol is a ground-up rewrite informed by running
[claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) in anger, and
patching it — several Patrol features were prototyped there first.

| | claude-peers-mcp (0.1.0) | Claude-Patrol |
|---|---|---|
| MCP surface per seat | 4 tools (send/list/summary/check) | 2 tools (summary/check); send/list/status are CLI verbs, near-zero schema payload |
| Push notifications | one per message → N messages = N paid wake-ups | **coalesced: one per poll batch** |
| Sender context | extra `list-peers` call per inbound message | joined by the broker at poll time |
| Broker auth | none — any local process can inject messages | shared-secret token, 0600 file |
| Seat identity | id + cwd | + role, model, profile (self-describing fleet) |
| Cost tracking | none | **per-seat live spend, subagent transcripts included** |
| Fleet launcher | none — open terminals by hand | `patrol up`: yaml config, tmux + headless backends, per-seat plugin subsets |
| Boot safety | boots on default model (measured $3.6–4.9/accident) | model required per seat, validated before launch |
| Deregistration | process exit only | SessionEnd hook + idempotent `/unregister` (by id or pid) + stale-PID sweep |
| Boot latency | LLM auto-summary API call (up to 3s, external dep) | opt-in only; seats self-describe |
| Message table | grows forever | delivered messages purged after 7 days |
| Packaging | manual clone + .mcp.json | Claude Code plugin (commands, skill, hook, MCP) + CLI/daemon |
| Tests | none | 189 across broker, costs, launcher, CLI, codex adapter, integration |

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
    profile: full          # everything on — the long-lived workhorse
  - name: builder
    model: opus
    profile: peer          # no plugins, patrol MCP only — cheap seat
  - name: scout
    model: sonnet
    backend: bg            # headless via `claude --bg` — see the caveat below
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

## Architecture

```
┌─ terminal 1 ─┐  ┌─ terminal 2 ─┐  ┌─ headless ──┐
│ claude       │  │ claude       │  │ claude --bg │
│  └ seat-srv ─┼──┼─ seat-srv ───┼──┼─ seat-srv ──┼──► broker (:7900)
└──────────────┘  └──────────────┘  └─────────────┘    ├ SQLite
        ▲                ▲                             ├ auth token
        └── channel push ┘        patrol CLI ──────────┤ /costs ◄─ session logs
                                  (send/list/status)   └ stale-PID sweep
```

- **Broker** — singleton localhost daemon, SQLite, auto-started by the first seat.
  All POSTs authenticated.
- **Seat server** — minimal stdio MCP per session: registers, polls, pushes coalesced
  `claude/channel` notifications. Everything else is the CLI.
- **Costs** — a background indexer parses `~/.claude/projects` session logs into an
  hour-bucketed SQLite ledger. Attribution tries the launch-token content match
  first, then the SessionStart hook, then a window heuristic that reports
  "unattributed" rather than guess wrong.

## Roadmap

Sequenced, not parallel: v0.2 has to prove itself in real use before v0.3 starts.
No dates.

**v0.2.3 — shipped.** Lease/ack delivery (`/poll-messages` leases, `/ack` settles,
unacked leases redeliver), so a live seat whose push failed doesn't silently drop
work. Codex seats hardened: read-only sandbox by default, a command-veto
`PreToolUse` deny hook for write-enabled seats, and an unforgeable prompt-injection
fence around inbound message bodies. Broker cost indexer bounded in both memory and
CPU. 189 tests.

**v0.2.4 — now, in progress.** Building on the fleet, by the fleet:
- **`backend: headless`** — a `claude -p --resume` adapter daemon (same shape as the
  codex seat). Pull-based by necessity: a headless session cannot receive
  `claude/channel` pushes, so the adapter polls and drives one turn per message.
- **Billing-source attribution.** After the 2026-06-15 split, programmatic
  (`claude -p`) launches draw a separate Agent-SDK credit pool, not the interactive
  subscription. `patrol status` now reports subscription / agent-sdk / external as
  three separate totals — never summed, because they bill different accounts.
- **Port broker.** The broker allocates a port per seat and exports `PATROL_PORT`, so
  parallel seats stop killing each other over `localhost:3000`.
- **File-ownership claims.** `patrol claim <path>` registers a seat as a path's owner;
  a competing claim is denied and names the holder. Advisory by default, with opt-in
  hook enforcement.
- **Command-center dashboard.** A single static HTML page served by the broker: a
  question inbox (agent questions surface in one place instead of scattered
  terminals), a work kanban derived from git worktrees + open PRs, the fleet board,
  and a live comms audit log.

**v0.3 — hardening.** The work that has to land before I'd suggest anyone depend on
this for real:
- Auth redesign: a unix domain socket plus per-seat capability tokens, so a seat's
  identity is bound rather than asserted. The tokens must gate `/poll-messages` and
  `/ack`, not just sending: today any caller holding the broker secret can read
  another seat's mail, and with `/ack` can silently destroy it — acking a victim's
  batch marks it delivered and it is never seen. A bound identity is also what a safe
  `patrol send --as <seat>` needs, which is why that flag was cut from v0.2.2 instead
  of shipped.
- Consumer-crash redelivery. v0.2.3's lease/ack covers a *live* seat whose push failed
  or whose broker blipped; it does **not** survive the seat process dying, because the
  stale-seat sweep deletes a dead seat's undelivered mail and a restarted seat comes
  back under a new id. Surviving a crash needs identity that is stable across restarts,
  so it is gated on the capability tokens above rather than shippable on its own.
- A writable-worktree root for codex seats. Today a codex seat's sandbox is scoped to
  its launch checkout, so it cannot implement in the per-package worktrees the fleet
  runs on — it's confined to read-only review and spec work until this lands.
- Plugin packaging, so a cloned install resolves its own paths.

**v0.4 — after it has proven itself.** A Rust CLI; SSE or long-poll replacing the 1s
poll; codex cost parsing, so non-Claude seats get their own per-seat spend (v0.2.4
tags *which pool*, not codex's own dollar figure); a retention sweep for the ledger;
per-task cost tags; a Warp launch backend.

## Status and caveats

**v0.2.3, 189 tests.** Cost attribution survives the case that broke it in v0.1:
several seats working in the same repo. It keeps history across seat teardown and
broker restarts, serves `/costs` from an incrementally indexed ledger instead of
walking every log on request, leases-and-acks delivery so a failed push doesn't drop
a live seat's mail, defaults codex seats to a read-only sandbox behind a command-veto
hook, fences delivered messages against header forgery, and validates all broker input.

This is a tool I built for my own fleet and then opened up. It is used daily, but by
one person on one machine, so expect sharp edges outside that path.

- **Single-machine by design.** No cross-host coordination.
- **The `claude/channel` capability is a Claude Code research preview**
  (`--dangerously-load-development-channels`). If it changes, delivery degrades to
  the `check_messages` fallback rather than breaking.
- **Reversal condition, stated up front:** if Anthropic ships persistent
  cross-session agent teams, Patrol's broker retires and the launcher + cost layer
  live on. That is written into `DESIGN.md`, not hidden.

Design decisions with kill criteria: [`DESIGN.md`](DESIGN.md). Research evidence:
[`research/`](research). Release notes: [`CHANGELOG.md`](CHANGELOG.md).

## Contributing

Issues and PRs are welcome, especially bug reports from a second machine — that is
the coverage I cannot give it myself.

```bash
bun install
bun test              # 189 tests
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
