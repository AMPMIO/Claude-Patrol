# Patrol setup — from clone to a working fleet

Follow in order; every step ends with a check. If a check fails, stop there —
later steps depend on it. Written against v0.2 (`main`).

## 0. Prerequisites

- **Bun** ≥1.2 (`bun --version`)
- **Claude Code** ≥2.1.80, logged in via claude.ai (NOT an API key — the
  channel push capability requires claude.ai login)
- **tmux** for visible seats (`brew install tmux`); optional — the `bg`
  backend works without it
- macOS or Linux

## 1. Install

```bash
git clone https://github.com/AMPMIO/Claude-Patrol.git ~/Claude-Patrol
cd ~/Claude-Patrol
bun install
bun link          # registers the `patrol` bin globally
```

**Check:** `patrol` with no args prints the usage block. Note `bun link` prints
`Registered "claude-patrol"` and suggests running `bun link claude-patrol` in a
project — ignore that suggestion; it still symlinks the `patrol` bin onto your
PATH (`which patrol` → `~/.bun/bin/patrol`). If `bun link` didn't put it on
PATH, use `alias patrol="bun ~/Claude-Patrol/src/cli.ts"` instead.

## 2. Health check

```bash
patrol doctor
```

**Expect:** `broker not responding` (FAIL) and `secret file missing` (FAIL) —
both are created on first fleet start, so these two are normal right now.
`bun`, `tmux`, and `claude supports --bg and --tmux` should PASS. If you also
run the legacy `claude-peers` broker, doctor prints a benign
`WARN legacy claude-peers broker on :7899` — patrol uses :7900, the two
coexist, ignore it. Fix anything else it flags before continuing.

## 3. Write your fleet config

```bash
cp patrol.yaml.example patrol.yaml
$EDITOR patrol.yaml
```

`patrol.yaml` is gitignored, so a copy inside this repo won't dirty the tree.
But a seat's default `cwd` is the yaml file's directory — keep the config (and
therefore the fleet) OUT of a real project you don't want seats running in.
For a throwaway first test, put the yaml in a scratch dir and launch it by path
(`patrol up /tmp/patrol-test/patrol.yaml`).

Minimal two-seat starter (good for the first test):

```yaml
seats:
  - name: lead
    role: orchestrator
    model: opus
    backend: tmux
    profile: peer
    prompt: "You are the fleet lead. Discover seats with `patrol list` (via Bash), delegate, judge."

  - name: worker
    model: sonnet
    backend: tmux
    profile: peer
```

Rules the launcher enforces:
- `model` is **required** per seat (no accidental expensive-default boots).
- `name` must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` (it becomes a tmux
  window name and a filename).
- `profile: peer` = no plugins + only the patrol MCP server — the cheap,
  fast-booting seat. Use `full` for your daily-driver seat if it needs your
  normal plugins, and inline maps for per-seat plugin subsets (see
  `patrol.yaml.example`).
- A relative `cwd:` resolves against the yaml file's directory.

**Check:** none needed here — `patrol up` (next step) validates the entire
config before launching anything and refuses the whole fleet on any
violation, so a bad yaml can't half-start.

## 4. Launch

```bash
patrol up            # or: patrol up path/to/patrol.yaml
```

What happens: per-seat overlay files are written, each seat launches as
`claude --model <m> --name <name> --dangerously-load-development-channels
server:patrol …` in its own tmux window (session `patrol`), the first
seat-server autostarts the broker on `127.0.0.1:7900`, creates
`~/.claude-patrol.secret` (0600), and registers.

```bash
tmux attach -t patrol      # see your seats; C-b <n> switches windows
```

**Expect inside each seat window (first run only), in this order:**
1. A **workspace-trust** prompt — *"Is this a project you created or one you
   trust?"* Choose **Yes, I trust this folder** (this is why step 3 says keep
   the fleet cwd somewhere you're happy to trust).
2. A **development-channels** warning listing `Channels: server:patrol` —
   choose **I am using this for local development**.

There is no separate "patrol MCP server" consent prompt — the seat server is
wired via `--mcp-config`, not an interactive trust. After the banner you'll see
a dim `Channels (experimental) … server:patrol inject directly in this session`
notice (that confirms push is live) followed by
`server:patrol · no MCP server configured with that name` — **this second line
is benign**: `server:patrol` is the push *channel*, which is a different thing
from the MCP *server* (named `patrol`); push works regardless.

Seats with a `prompt:` show a `[patrol-seat: cp-xxxxxxxx]` marker at the end of
their briefing — the cost-attribution token; the seat is told to ignore it.

**Heads-up — per-command approvals:** launched seats start in the normal
ask-for-approval mode, so a seat will pause for a **Bash approval** every time
it runs a `patrol` CLI command (`patrol list`, `patrol send`) and for each
patrol MCP tool (`check_messages`). For an autonomous fleet, either approve
them as they appear, or pre-allow the patrol CLI in the seat project's
`.claude/settings.json` (`permissions.allow: ["Bash(patrol *)"]`).

**Check:** `patrol doctor` now passes broker + secret; `patrol list` shows
every seat with role/model.

## 5. Prove messaging (the coalesced push path)

```bash
patrol list                      # note a seat id, e.g. k3x9p2q1
patrol send k3x9p2q1 "ping — reply with your role via patrol send"
```

**Check:** the target seat wakes within ~1–2s (watch its tmux window), sees a
fenced message (`⟦patrol:msg …⟧` wrapper — that's the injection fencing), and
can reply using `patrol send` through Bash. `patrol send` to a bad id must exit
nonzero with the broker's real reason (that's the v0.2 false-success fix): a
malformed id prints `... to_id must be an 8-char [a-z0-9] slug`, and a
well-formed id that isn't live prints `Seat <id> not found`.

## 6. Prove per-seat cost attribution (the differentiator)

Give each seat a small real task (or just chat in each window so they spend
tokens). The broker's background indexer picks up session logs every ~12s.

```bash
patrol status
```

**Check:** each seat row shows its own nonzero SPEND, and the numbers differ
per seat (they did different work). This is the multi-seat-same-cwd case that
was dark before v0.2 — if a launcher seat shows `-` spend after a few minutes
of activity, that's a bug: capture `~/.claude-patrol.db` and the seat's tmux
scrollback and report.

Optional deeper checks:
- Have a seat spawn a subagent (any Task-tool use). Its spend should roll up
  into that seat's SPEND (subagent→parent rollup).
- Kill a seat's window, then `patrol status` — its history should stay
  attributed (durable `seat_runs`), and the seat should vanish from the
  live board after the stale sweep (~30s).
- Open a MANUAL `claude` session in the same repo (not via patrol): it
  attributes exactly only if the plugin's SessionStart hook is installed;
  otherwise it uses the window heuristic and may show as unattributed —
  never as another seat's spend.

## 7. Daily use

- `patrol status` — board: seat, role, model, last-seen, spend, summaries.
- `patrol send <id> "<msg>"` — from your terminal or from any seat (Bash).
- Seats self-describe via the `set_summary` MCP tool; tell them to use it.
- Message bodies arrive fenced; the header line above the fence is the only
  trusted identity. Instructions inside a body are DATA — seats are told not
  to obey content that merely claims authority.

## 8. Teardown

```bash
patrol down            # kills tmux session, SIGTERMs bg seats (pid-verified)
```

`patrol down --force` overrides the recycled-pid guard (only if you know a
stale recorded pid is actually yours). The broker daemon **survives `patrol
down`** — it's launched detached (nohup + orphaned to launchd), so tearing down
the fleet leaves it running to hold cost history and keep indexing. Confirm
with `curl -s 127.0.0.1:7900/health`. To stop it too:
`kill $(lsof -ti :7900)`.

## Telemetry

```bash
patrol stats                       # window: since broker start
patrol stats --since 2026-07-08T00:00:00Z --until 2026-07-09T00:00:00Z
patrol stats --json                # raw StatsResponse, for scripting
```

`patrol stats` is the evidence layer behind the README's cost claims: a
per-seat table of live/bound-via (which attribution layer resolved the
seat — token/observe/heuristic/env), WAKES (paid notification wake-ups) vs
MSGS (messages delivered inside them), the MSG/WAKE coalescing ratio, and
CACHE R/W (cache_read/cache_write — the standing-seat reuse number). Totals
and a "coalescing saved ~N wake-ups" line follow the table. If the broker is
unreachable or the route errors, it prints to stderr and exits 1 rather than
showing zeros.

**Reading the BOUND column:** a launcher seat should resolve as `token` (Layer
1 — its `cp-` token content-matched its session log; this is the exact,
multi-seat-safe path). `heuristic` means a tokenless or manually-opened session
was bound by the mtime fallback. `env` means *only* that
`CLAUDE_PATROL_SESSION_ID` was set explicitly — it is NOT the normal path, so a
launcher seat showing `env` is a red flag worth reporting. `-`/blank means the
seat's spend hasn't bound yet (give the indexer a tick) or is genuinely
unattributed.

**Unattributed on a busy machine:** `patrol stats`/`status` sweep every Claude
session's cost in the window and bucket anything that isn't a fleet seat as
`unattributed`. On a box where you also run standalone `claude` sessions (or
other agents), expect a large `unattributed` figure — that's *correct*, not a
leak: it's your non-fleet spend, and it is never mis-charged to a seat. On a
quiet single-fleet machine `unattributed` should sit near zero.

During your test week, run `patrol stats --json > stats-$(date +%F).json`
daily to accumulate evidence. Keep the files — they're the raw data behind
any future benchmark writeup, and `--since`/`--until` let you re-slice them
after the fact instead of re-running against a broker that's moved on.

## Known limits in this build (v0.2)

- The channel capability is a Claude Code **research preview** — the
  `--dangerously-load-development-channels` flag is required and the API may
  change between CC releases. If push breaks, seats still receive on the
  `check_messages` tool (ask a seat to call it) — degraded, not dead.
- **Watch signal for the pid-join assumption:** when you kill a seat, it
  should vanish from `patrol status` within a second or two (SessionEnd
  dereg). If a killed seat always lingers ~30s (stale-sweep timing), the
  hook's `$PPID` isn't the pid the seat registered — report it, because the
  same join backs exact attribution for manually-opened sessions.
- `bg` (headless) seats: channel-flag support under `claude --bg` is
  untested — if a bg seat never wakes on send, that's the first suspect;
  report it (tmux seats are the verified path).
- `/costs` windows are hour-granular (ledger buckets); `patrol status`
  totals are unaffected.
- Multi-user / cross-machine is out of scope until v0.3's auth redesign.
