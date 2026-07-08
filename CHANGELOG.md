# Changelog

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
