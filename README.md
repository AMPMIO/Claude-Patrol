# Claude-Patrol

**Standing-seat fleet coordination for Claude Code** — an authenticated local
broker, coalesced push messaging between independent terminal sessions,
per-seat cost tracking, and a profile-aware fleet launcher.

```
patrol up          # boot a whole fleet from patrol.yaml — one command
patrol status      # who's running, what role, what model, WHAT IT COSTS
patrol send <id> "review the diff in ~/proj/x"
patrol down        # tear it all down
```

## Why standing seats at all

Measured on real workloads (July 2026, identical fixed-spec dev task, same
model mix, cost from session logs at list prices — **one run per topology so
far; read it as ~2–3× until the repeat runs land**, tracked for v0.2):

| topology | cost | wall-clock |
|---|---|---|
| orchestrator + **subagents** (spawn per task) | $6.22 | 13m 15s |
| orchestrator + **standing peer seats** | **$2.16 (−65%)** | **5m 03s (−62%)** |

Both passed the same quality gate; output tokens were near-identical. The
difference is overhead: every subagent spawn re-buys the standing context as
cache *writes* (~100–150k tokens on a plugin-heavy config), while a standing
seat wrote it once and reads it back at 1/12.5 the price. Standing seats
amortize after roughly **one** task.

Patrol exists to make that topology cheap to run and trivial to operate.

## What Patrol does that raw terminals don't

1. **One command, N pre-profiled seats.** `patrol up` reads `patrol.yaml` and
   boots each seat with its own model, role, working dir, backend (tmux
   window or headless `claude --bg`), and boot profile — including per-seat
   plugin subsets. No more 10 manual steps per fleet.
2. **A hard boot guard.** A seat cannot launch without an explicit model.
   Booting a seat on an expensive default model costs real money before it
   does any work (measured: $3.6–4.9 per accidental boot, three times in one
   evening). Patrol makes that mistake structurally impossible.
3. **Per-seat cost tracking — the feature no peer tool has.** `patrol status`
   shows live spend per seat, computed from Claude Code's own session logs,
   *including subagent transcripts rolled up to their parent seat* (omitting
   those undercounted real runs by 63% before we caught it). v0.2 made
   attribution exact for the standard case: every launched seat carries a
   `[patrol-seat: cp-…]` token in its boot prompt, content-matched to its
   session log — N seats in one repo each get THEIR number, and history
   survives seat teardown and broker restarts in a durable SQLite ledger.
   Fleet economics stop being vibes.
4. **Coalesced wake-ups.** Every push notification wakes the receiving
   session for a full turn at full context price. Patrol delivers each poll
   batch as ONE notification, however many messages queued — N messages
   never cost N turns.
5. **An authenticated broker with fenced delivery.** Without auth, any local
   process can POST text into your Claude sessions framed as a teammate — a
   prompt-injection surface. Patrol gates the broker with a 0600
   shared-secret file (symlink/uid/perms-checked at every read), validates
   every request's shape and size, and (v0.2) wraps each delivered message
   body in a per-notification random fence — a body cannot forge a sibling
   `[from …]` header or speak with another seat's authority.
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
| Tests | none | 60+ across broker, costs, launcher, CLI |

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
- **Costs**: parsed from `~/.claude/projects` session logs; exact attribution
  via discovered session ids, window-based fallback otherwise.

## Status / caveats

v0.2 — the differentiator is real now: exact multi-seat-same-repo cost
attribution (3 layers: launch-token content match → SessionStart hook →
never-misattribute window heuristic), durable cost history, `/costs` served
from an incrementally-indexed ledger (no log walk on the status path),
provenance-fenced message delivery, validated broker input. 110 tests.

Single-machine by design. The `claude/channel` capability is a
research-preview Claude Code feature (`--dangerously-load-development-channels`);
if it changes, delivery degrades to the `check_messages` fallback. Warp-native
launch backend is planned (tmux and headless cover today). If Anthropic ships
persistent cross-session agent teams, Patrol's broker retires and the
launcher + cost layer live on — that reversal condition is written into
DESIGN.md.

Design decisions with kill criteria: `DESIGN.md`. Research evidence:
`research/`.
