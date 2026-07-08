# Changelog

## 0.2.0 — 2026-07-08

The "make the differentiator real" wave: per-seat cost attribution — broken
in the normal multi-seat-same-repo case in 0.1 — now works exactly, plus the
daily-use reliability and single-user security fixes from the adversarial
review. Five work packages against a frozen contract; 110 tests.

### Fixed
- **Cost attribution in the standard fleet case** (the flagship defect):
  0.1's mtime-window heuristic collapsed to *unattributed* whenever ≥2 seats
  booted in one cwd. Now 3 layers, precedence high→low:
  1. **Launch-token content match** (launcher seats; primary): `patrol up`
     injects a per-seat `cp-<8hex>` token into the boot prompt AND env; the
     broker substring-matches it to the one session log containing it.
     Immune to N-seats-same-cwd. Spike- and byte-level tmux-verified.
  2. **SessionStart hook** (manual seats): the plugin posts
     `{session_id, transcript_path, cwd, claude_pid}` to `/observe-session`.
  3. **Window heuristic** (fallback, unchanged): exactly-one-or-null — a
     seat degrades to unattributed, never to someone else's number.
- **Subagent spend leak**: subagent transcripts now roll up to their parent
  seat (their own model rows stay visible in `/costs`).
- **Cost history died with the seat**: durable `seat_runs` (ended runs keep
  their session binding) + `cost_ledger` (per session/model/hour) survive
  unregister, teardown, and broker restarts.
- **`/costs` walked all history on the sync path**: a background indexer
  (~12s) parses only appended log tails; `/costs` is table-reads-only and
  `patrol status` renders instantly (spend at most one tick stale;
  windows are hour-granular).
- **Launched seats had no channel push**: `composeSeat` never passed
  `--dangerously-load-development-channels server:patrol`, so messages only
  arrived via manual `check_messages`. Found post-merge while writing
  SETUP.md; every non-`mcp:none` seat now carries the flag.
- **`patrol send` false success**: app-level `{ok:false}` now exits nonzero.
- **`patrol down` could kill a recycled pid**: unverified recorded pids are
  `ps`-checked to still look like claude, refused otherwise (`--force`
  overrides).
- **SessionEnd dereg pid mismatch**: the seat-server now registers the
  claude process pid (`ppid`), so the hook's `$PPID` dereg joins and broker
  liveness tracks the actual session.
- **Relative `cwd:` in patrol.yaml** resolves against the config file's
  directory, not the invoker's cwd.
- **`patrol status` hidden behind slow `/costs`**: board renders from the
  seat list; spend degrades to "unavailable" instead of blocking.

### Security (single-user threat model — content is the adversary)
- **Provenance fencing**: every delivered message body is wrapped in a
  per-notification random boundary; sender metadata is sanitized to one
  fence-glyph-free line. A body can't forge a `[from …]` header, terminate
  its own fence, or impersonate a teammate. Single and batch delivery share
  one code path; coalescing (one notification per poll batch) preserved.
- **Broker input validation**: per-route shape/type checks, text ≤8KiB,
  summary ≤500 chars, 64KiB request cap, queue-depth cap (429), seat_token
  format check; `/send-message` rejects a `from_id` that isn't a live seat
  or `"cli"`.
- **Seat-name slug**: `patrol.yaml` names must match
  `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` — a crafted name was a path-traversal +
  tmux-target vector from a possibly-cloned config.
- **Secret hardening**: `getSecret()` refuses symlinks and foreign-uid
  files, self-repairs over-permissive modes to 0600; one shared
  `checkSecretPerms` for server and doctor.

### Docs / integrity
- README + DESIGN now label the 2.9×/−65% headline as single unrepeated
  runs (repeat runs tracked); `SETUP.md` added — step-by-step fleet setup
  with a verification per step.

### Known gaps (tracked for the v0.2 real-use week / v0.3)
- `claude --bg` + channel flag untested headless; Layer-2's
  `claude_pid = $PPID` assumption degrades to Layer 3 if CC ever wraps
  hooks in a shell; `seen_msgs`/ledger have no pruning yet; auth identity
  redesign + plugin packaging are v0.3 gates.

## 0.1.0 — 2026-07-08

Ground-up rewrite of the standing-seat coordination layer previously run as
a patched claude-peers-mcp (its `feat/coalesce-metadata-auth` branch was the
prototype for several items below).

### Added
- **Broker daemon** (`src/broker.ts`, :7900): SQLite-backed seat registry +
  message routing; shared-secret auth on every POST (`~/.claude-patrol.secret`,
  0600, auto-created); stale-PID sweep; delivered-message purge (7 days);
  idempotent `/unregister` by seat id or pid; additive schema migrations.
- **Seat server** (`src/seat-server.ts`): minimal per-session stdio MCP —
  register (role/model/profile from `CLAUDE_PATROL_*` env), heartbeat,
  poll → **one coalesced `claude/channel` notification per batch** (N queued
  messages never cost N session wake-ups). Only two MCP tools (`set_summary`,
  `check_messages`); send/list/status are CLI verbs to keep per-seat schema
  payload near zero.
- **Per-seat cost tracking** (`src/costs.ts`, `/costs`): parses Claude Code
  session logs including `*/subagents/*.jsonl` (regression-locked — omitting
  them undercounted real runs by 63%); exact attribution via session-id
  discovery with cross-seat uniqueness guard, window-scoped fallback
  otherwise; priced per model at list rates.
- **Fleet launcher** (`patrol up` / `patrol down`): `patrol.yaml` config;
  tmux backend (session "patrol", window per seat) and headless backend
  (`claude --bg`, tracked via `claude agents --json`); per-seat boot
  profiles incl. **plugin subsets** (generated `enabledPlugins` overlays);
  hard validation — a seat without an explicit `model` refuses to launch.
- **Fleet board** (`patrol status`): seats with role/model/profile/last-seen
  + live per-seat spend, unattributed bucket, fleet total.
- **`patrol doctor`**: 7 environment/health checks incl. legacy claude-peers
  coexistence warning and stale-seat detection.
- **Claude Code plugin** (`plugin/`): `/patrol-status` + `/patrol-brief`
  commands, per-role briefing skill, SessionEnd auto-dereg hook (by `$PPID`),
  seat-server MCP wiring.
- Tests: 60+ across broker (live instance on alt port), costs (fixture
  tree with subagent transcripts), launcher (pure argv/env composition),
  CLI (stub broker).

### Design
- Architecture decisions + kill criteria in `DESIGN.md`; research evidence
  in `research/r1–r3`. Headline numbers: standing seats beat subagent
  spawning $2.16 vs $6.22 (−65%) at equal quality on the benchmark task.
