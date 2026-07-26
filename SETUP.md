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
patrol init            # wizard: asks for seats, writes + gitignores patrol.yaml
patrol init --ai       # same, but reads the repo and your goal and suggests a fleet
```

`--ai` runs a single `claude -p` pass, off the interactive budget. It is isolated
on purpose — empty MCP config, no tools, a temp cwd so no project `CLAUDE.md`,
settings, or hooks load, and everything it reads out of the repo is fenced as
untrusted data. It only ever *proposes* a config; you still review what it wrote.

Or start from the annotated example, which shows every field that exists:

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

Optional fields worth knowing:
- `budget_usd:` — per seat, or once at the top level as the fleet default. The
  seat that crosses it pings `budget_alert_to` (a handle or a role; default: the
  `orchestrator`-role seat) **once**. Observe-only — it never stops a seat.
- `sandbox:` — codex seats only, `read-only` by default. `workspace-write` opts a
  codex seat into editing files, confined to its own working directory and behind
  a `PreToolUse` deny-hook over destructive commands.
- `ports: N` — parsed, but **not yet delivered to the seat**: nothing exports the
  allocated ports into the seat's environment. Until that lands, use
  `patrol claim-port <seat> <n>` and hand the ports to the seat yourself.

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

- `patrol status` — board: seat, id, role, model, profile, tty, branch, last-seen,
  spend, budget, summary. `OVER` in the spend cell means the seat crossed its
  `budget_usd`; `LEASED` in the branch cell means a checkpoint is holding it.
- `patrol send <handle> "<msg>"` — from your terminal or from any seat (Bash).
  Handles are readable and assigned at register (`builder`, `reviewer`);
  `patrol rename <old> <new>` changes one. The hex id still works everywhere.
- `patrol wait <handle> --until done --timeout 300` — block a script until a seat
  reports a state, instead of polling `patrol status` in a loop. Seats self-report
  `idle | working | blocked | done` via the `set_state` MCP tool.
- `patrol claim <seat> <path>...` / `patrol claims` / `patrol release <seat>` —
  advisory file ownership, so two seats stop editing the same file. A competing
  claim is denied and names the holder. `patrol claim-port <seat> <n>` does the
  same for ports.
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
`kill $(lsof -ti :7900 -sTCP:LISTEN)` — the `-sTCP:LISTEN` matters: a bare
`lsof -ti :7900` also matches the client sockets of anything connected to the
broker (a running `patrol watch`, seat servers), and you'd kill those too.

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

## Watch the fleet

```bash
patrol watch
```

A full-screen live TUI (run it in its own terminal or tmux window, not
inside a seat): a fleet board of every seat on the machine across all
projects (seat, role, model, cwd, live, spend, summary), a running log of
inter-seat messages below it, and a send bar at the bottom.

Keys: `Tab` cycles the send target through live seats; `Enter` sends the
typed message (as `cli`, same as `patrol send`); `↑`/`↓`/`PgUp`/`PgDn`
scroll the log (it auto-follows the newest message unless you've scrolled
up, and shows an "N new" hint until you return to the bottom); `q` or
Ctrl-C quits and restores the terminal.

Polling: log 1s, seats 2s, spend 5s. If the broker dies mid-watch you get a
reconnect banner, not a crash — it recovers when the broker is back. A send
to a dead or malformed id shows the broker's real error inline above the
input.

## The command center

```bash
patrol dash            # opens the dashboard in your browser
```

Four panes, all served by the broker:

- **Question inbox.** A seat that needs a human decision calls `/ask`; the question
  lands here instead of in a tmux window you weren't looking at. You answer, and the
  broker routes the answer back to the asking seat as an ordinary message. Answering
  a seat that has since died is rejected with the reason (the question stays open),
  not silently swallowed.
- **Fleet board** with live seat state (`idle | working | blocked | done`).
- **Comms audit log** — every message that crossed the broker.
- **Working diff** per seat — tracked changes plus untracked new files, capped at
  256 KiB — and the three-wallet billing strip.

**Security, since this is a browser page:** it is loopback-only. `patrol dash` mints
a short-lived nonce and opens `GET /dashboard?t=<nonce>`; the page never sees the
broker secret. That nonce authenticates the **read routes and `/answer`, nothing
else** — every write route (send, register, unregister, ack, claims) still demands
the full secret, and a request without a loopback `Origin`/`Host` is refused. Do not
try to expose this port off the machine; nothing here is built for that.

## The cockpit

```bash
patrol cockpit         # one tmux window: big focus pane + tiled previews
```

Keys: `Ctrl-b z` zooms the focused seat fullscreen, `Ctrl-b P` promotes a preview
into the big top slot, `Ctrl-b ↑/↓` and `Ctrl-b o` move between panes. The hints
live in the status bar. These are the seats' real terminals joined into one window
(`join-pane`), not a rendered summary — each seat's live process is preserved, and
`patrol cockpit` does not restart anything.

## A worktree per task

The seat is standing; the *task* gets the worktree.

```bash
patrol worktree builder feat/parser        # cut a task tree, tell the seat where
# ... the seat works, commits on feat/parser ...
patrol checkpoint builder --gate "bun test"
```

`worktree` creates a tracked worktree under `.claude/worktrees/` and messages the
seat its path. `checkpoint` runs the gate inside that worktree, merges the branch
back into `main`, and removes the tree. The branch is left in place — deleting a
branch is destructive and out of scope.

What it will not do, by design:

- It never runs `checkout`/`merge`/`reset` against your primary checkout. The merge
  happens in a throwaway integration worktree, and git's one-branch-one-worktree
  rule refuses that worktree if trunk is already checked out somewhere live — that
  refusal is the concurrency interlock.
- A conflict STOPs with the trunk ref untouched.
- The seat's tree is removed **without** `--force`, so uncommitted work blocks the
  removal instead of being destroyed.

**Check:** `patrol status` shows a `LEASED` marker in the seat's `BRANCH` cell while
a checkpoint holds its lease, and the seat's own tool calls are denied with
*"patrol checkpoint in progress on this seat's worktree"* for those few seconds.

**The honest limit.** The lease binds the seat's **tool calls**, through a
`PreToolUse` guard hook the launcher installed. So:

- A tool call already in flight when the lease lands still completes. Checkpoint
  waits it out and proves the branch tip has stopped moving before merging.
- A background process the seat launched earlier — dev server, watcher, long build —
  is not covered and can still write.
- A seat with no guard hook cannot be quiesced at all. `checkpoint` therefore
  **refuses** an adapter seat (`backend: codex` or `headless`), and refuses a seat
  that reports `guarded` with no lease-file path. `--force` accepts the older
  fences-only behavior, which detects a mid-checkpoint commit rather than preventing
  it — it reports `INCOMPLETE` with the branch intact instead of a false success.
- The hook fails open on every error path (missing file, expired lease, malformed
  JSON, unreadable). A checkpoint killed mid-run must not wedge a seat forever.

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
- `bg` (headless) seats **do not wake on push** — CONFIRMED (2026-07-10 live
  test): the development-channels capability requires an interactive consent
  no headless session can answer, so the channel never registers and pushes
  are silently dropped. The seat still registers, heartbeats, and can be
  driven by its launch prompt or `claude attach`; it just won't react to
  `patrol send`. Use tmux for any seat that must receive messages; treat
  `bg` as outbound-only until the plugin ships on an approved allowlist
  (v0.3 packaging).
- `/costs` windows are hour-granular (ledger buckets); `patrol status`
  totals are unaffected.
- A `codex` seat shows `$—` in `patrol status`, not `$0`: codex writes no Claude
  Code session log, so there is nothing to attribute. Absent, never charged to
  another seat. Reading codex's own usage is a v0.4 item.
- `patrol checkpoint` quiesces a seat's **tool calls**, not its processes, and
  refuses an unguarded seat (`codex`, `headless`) without `--force`. Full
  explanation under [A worktree per task](#a-worktree-per-task).
- `ports:` in `patrol.yaml` is accepted but not delivered into the seat's
  environment yet; use `patrol claim-port`.
- The dashboard is loopback-only and its nonce is scoped to the read routes plus
  `/answer`. Don't expose the broker port.
- Multi-user / cross-machine is out of scope until v0.3's auth redesign.
