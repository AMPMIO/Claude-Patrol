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

**Check:** `patrol` with no args prints the usage block. If `bun link` didn't
put it on PATH, use `alias patrol="bun ~/Claude-Patrol/src/cli.ts"` instead.

## 2. Health check

```bash
patrol doctor
```

**Expect:** `broker not responding` (FAIL) and `secret file missing` (FAIL) —
both are created on first fleet start, so these two are normal right now.
`bun`, `tmux`, and `claude supports --bg and --tmux` should PASS. Fix anything
else it flags before continuing.

## 3. Write your fleet config

```bash
cp patrol.yaml.example patrol.yaml
$EDITOR patrol.yaml
```

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

**Expect inside each seat window (first run only):** Claude Code shows a
consent prompt for the patrol MCP server and the development-channel entry —
approve them. A dim `Channels (experimental) … server:patrol` notice below
the banner confirms push delivery is live. Seats with a `prompt:` will show a
`[patrol-seat: cp-xxxxxxxx]` marker at the end of their briefing — that's the
cost-attribution token; the seat is instructed to ignore it.

**Check:** `patrol doctor` now passes broker + secret; `patrol list` shows
every seat with role/model.

## 5. Prove messaging (the coalesced push path)

```bash
patrol list                      # note a seat id, e.g. k3x9p2q1
patrol send k3x9p2q1 "ping — reply with your role via patrol send"
```

**Check:** the target seat wakes within ~1–2s (watch its tmux window), sees a
fenced message (`⟦patrol:msg …⟧` wrapper — that's the injection fencing), and
can reply using `patrol send` through Bash. `patrol send` to a nonexistent id
must exit nonzero with an error (that's the v0.2 false-success fix).

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
stale recorded pid is actually yours). The broker daemon stays up (it's
cheap and holds cost history); to stop it too:
`kill $(lsof -ti :7900)`.

## Known limits in this build (v0.2)

- The channel capability is a Claude Code **research preview** — the
  `--dangerously-load-development-channels` flag is required and the API may
  change between CC releases. If push breaks, seats still receive on the
  `check_messages` tool (ask a seat to call it) — degraded, not dead.
- `bg` (headless) seats: channel-flag support under `claude --bg` is
  untested — if a bg seat never wakes on send, that's the first suspect;
  report it (tmux seats are the verified path).
- `/costs` windows are hour-granular (ledger buckets); `patrol status`
  totals are unaffected.
- Multi-user / cross-machine is out of scope until v0.3's auth redesign.
