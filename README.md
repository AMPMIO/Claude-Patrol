# Claude-Patrol

**Standing-seat fleet coordination for Claude Code** — an authenticated local
broker, coalesced push messaging between independent terminal sessions,
per-seat cost tracking, and a profile-aware fleet launcher.

```
patrol up          # boot a whole fleet from patrol.yaml — one command
patrol status      # who's running, what role, what model, what it costs
patrol send <id> "review the diff in ~/proj/x"
patrol down        # tear it all down
```

## Why standing seats at all

Measured on real workloads (July 2026, identical fixed-spec dev task, same
quality gate, cost from session logs at list prices). Config-matched
comparison — both runs on the same plugin-heavy seat configuration:

| topology (plugin-heavy config) | cost | wall-clock |
|---|---|---|
| orchestrator + **subagents** (spawn per task) | $6.22 | 13m 15s |
| orchestrator + **standing peer seats** | **$2.16 (−65%)** | **5m 03s (−62%)** |

The mechanism is context weight, and we've measured it directly: every
subagent spawn re-buys the seat's standing context (system prompt, MCP
schemas, CLAUDE.md) as cache *writes* — ~138k tokens per spawn on the heavy
config vs ~36k on a minimal one. A repeat of the subagent run on a
stripped-down orchestrator came in at $1.06: about 80% of the heavy run's
cost was config weight being repurchased per spawn and re-read per turn, not
the task itself. A standing seat buys its context once and reads it back at
1/12.5 the write price, amortizing after roughly one task.

Two honest caveats: sample sizes are 1–2 runs per cell, and dollar totals are
sensitive to the exact subagent mix — the robust, repeatable number is the
per-spawn cache-write re-buy. So the cost driver is config weight × spawn
count, and Patrol attacks both ends: standing seats amortize the buy, and
per-seat profiles (`peer`, `lite`) shrink what gets bought at all.

Patrol exists to make that topology cheap to run and easy to operate.

## What Patrol does that raw terminals don't

1. **One command, N pre-profiled seats.** `patrol up` reads `patrol.yaml` and
   boots each seat with its own model, role, working dir, backend (tmux
   window or headless `claude --bg`), and boot profile, including per-seat
   plugin subsets. That replaces about ten manual steps per fleet.
2. **A hard boot guard.** A seat cannot launch without an explicit model.
   Booting a seat on an expensive default model costs real money before it
   does any work (measured: $3.6–4.9 per accidental boot, three times in one
   evening). Patrol refuses the launch instead.
3. **Per-seat cost tracking — the feature no peer tool has.** `patrol status`
   shows live spend per seat, computed from Claude Code's own session logs.
   Subagent spend rolls up to the seat that spawned it; leaving subagent
   transcripts out undercounted real runs by 63% before we caught it. Every
   launched seat carries a `[patrol-seat: cp-…]` token in its boot prompt,
   content-matched to its session log, so ten seats working in one repo each
   get their own number rather than a shared guess. The history lives in a
   SQLite ledger that survives seat teardown and broker restarts.
4. **Coalesced wake-ups.** Every push notification wakes the receiving
   session for a full turn at full context price. Patrol delivers each poll
   batch as one notification, however many messages queued — N messages
   never cost N turns.
5. **An authenticated broker with fenced delivery.** Without auth, any local
   process can POST text into your Claude sessions framed as a teammate.
   Patrol gates the broker with a 0600 shared-secret file (symlink, owner,
   and permission checks on every read) and validates every request's shape
   and size. Since v0.2, each delivered message body is wrapped in a
   per-notification random fence, so a body can't forge a `[from …]` header
   or borrow another seat's authority.
6. **Seats that describe themselves.** Role/model/profile ride along at
   registration (`CLAUDE_PATROL_*` env, set by the launcher). Orchestrators
   route work by the seat list instead of burning a round-trip asking every
   seat what it runs.

## Comparison: Claude-Patrol vs claude-peers-mcp

Patrol is a ground-up rewrite informed by running
[claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) in anger
(and patching it — several Patrol features were prototyped there first).

| | claude-peers-mcp (0.1.0) | Claude-Patrol |
|---|---|---|
| MCP surface per seat | 4 tools (send/list/summary/check) | 2 tools (summary/check) — send/list/status are CLI verbs, near-zero schema payload |
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
| Tests | none | 110 across broker, costs, launcher, CLI, integration |

## Quickstart

Full step-by-step (with a verification per step): **[SETUP.md](SETUP.md)**.
The short version:

```bash
bun install && bun link
cp patrol.yaml.example patrol.yaml   # edit seats
patrol up
patrol status
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
    backend: bg            # headless via `claude --bg`
    profile: peer
    prompt: "You are a research scout. Await tasks via patrol."
```

Profiles: `lite` (no plugins, no MCP), `peer` (no plugins + patrol seat
server), `full` (inherit everything), or an inline map with a per-seat
plugin subset:

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

- **Broker**: singleton localhost daemon, SQLite, auto-started by the first
  seat. All POSTs authenticated.
- **Seat server**: minimal stdio MCP per session — registers, polls, pushes
  coalesced `claude/channel` notifications. Everything else is the CLI.
- **Costs**: a background indexer parses `~/.claude/projects` session logs
  into an hour-bucketed SQLite ledger. Attribution tries the launch-token
  content match first, then the SessionStart hook, then a window heuristic
  that reports "unattributed" rather than guess wrong.

## Status / caveats

v0.2. Cost attribution now survives the case that broke it in v0.1: several
seats working in the same repo. It also keeps history across seat teardown
and broker restarts, serves `/costs` from an incrementally indexed ledger
instead of walking every log on request, fences delivered messages against
header forgery, and validates all broker input. 110 tests.

Single-machine by design. The `claude/channel` capability is a
research-preview Claude Code feature (`--dangerously-load-development-channels`);
if it changes, delivery degrades to the `check_messages` fallback. Warp-native
launch backend is planned (tmux and headless cover today). If Anthropic ships
persistent cross-session agent teams, Patrol's broker retires and the
launcher + cost layer live on — that reversal condition is written into
DESIGN.md.

Design decisions with kill criteria: `DESIGN.md`. Research evidence:
`research/`.
