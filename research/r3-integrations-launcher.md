# R3 — Optional Integrations + Fleet Launcher

**Decision this feeds:** whether/how Patrol ships rtk/caveman/ponytail as optional
installs, and which fleet-launch mechanism (tmux/Warp/iTerm/headless) Patrol
builds first for "one command, N pre-profiled seats."

**Bottom line:** All three integrations are public MIT/Apache-2.0 repos with
zero publishing restrictions — Patrol can ship an install recipe (not vendored
code) for each. For the launcher: tmux first (already installed, zero
dynamic-parameter friction, and Claude Code's own CLI already has a `--tmux`
convention to imitate); `claude agents`/`--bg` for headless seats (this is a
first-class built-in dispatcher, not a `claude -p &` hack); Warp as a
second-tier optional launcher (real scriptable path exists via YAML launch
configs + URI scheme, but requires generating a temp file per run and has no
native per-pane env field). iTerm/AppleScript: skip as a build target — not
installed on this machine, and `claude --tmux` already treats iTerm as
opportunistic, not required.

**Confidence:** high on integrations (verified from files on disk); high on
tmux/headless; medium on Warp (docs verified, but no local Warp CLI to test
end-to-end — see Dead ends). **What would change this:** if Warp ships
parameterized Tab Configs (tracked in open issues #12343/#9083) it stops
needing generated files, closing most of the gap with tmux.

## Findings

### Part 1 — Integrations

- **rtk is open-source, Apache-2.0, publishable.** — VERIFIED (primary:
  `brew info rtk` on this machine → License: Apache-2.0, formula at
  `github.com/Homebrew/homebrew-core`; GitHub search confirms upstream source
  at `github.com/rtk-ai/rtk`, "Rust binary, zero dependencies"). Implication:
  Patrol can document `brew install rtk` as the install step, no fork needed.

- **rtk hooks in at PreToolUse, matcher `Bash`, one line: `rtk hook claude`.**
  — VERIFIED (primary: read `~/.claude/settings.json` directly on this
  machine). It does NOT touch Grep/Glob/Read — only Bash tool calls get
  rewritten. Implication: Patrol's integration recipe is "append one
  PreToolUse/Bash hook entry to the seat's `--settings` file" — a 4-line JSON
  merge, safe to script non-destructively per seat.

- **23% measured local savings (from the brief) is SINGLE-SOURCE** (one
  machine's `rtk gain` history) **vs 60–90% / 89% average claimed publicly**
  (rtk-ai.app/savings, DEV Community writeup, HN thread) — DISPUTED only in
  magnitude, not direction. Explanation: public numbers average across
  high-noise commands (cargo test, git status); this machine's mix is
  presumably lighter on those. Implication: don't hard-code "23%" or "89%" in
  Patrol marketing — report per-fleet, measured, via `rtk gain`.

- **caveman is MIT, github.com/JuliusBrussee/caveman, shipped as a real Claude
  Code plugin.** — VERIFIED (primary: read `.claude-plugin/marketplace.json` +
  `plugin.json` + `LICENSE` directly from
  `~/.claude/plugins/cache/caveman/caveman/0d95a81d35a9/`). Hooks: SessionStart
  (`src/hooks/caveman-activate.js`) + UserPromptSubmit
  (`src/hooks/caveman-mode-tracker.js`), both Node, both under 5s timeout. It
  also ships a universal installer (`bin/install.js`, `install.sh`,
  `install.ps1`) that detects and configures Gemini, Codex, Cursor, Windsurf,
  and others — not Claude-Code-only. Implication: installable today via
  standard plugin marketplace flow (`claude plugin marketplace add
  JuliusBrussee/caveman` → `claude plugin install caveman`), no restrictions.

- **ponytail is MIT, github.com/DietrichGebert, same plugin shape.** —
  VERIFIED (primary: same file reads under
  `~/.claude/plugins/cache/ponytail/ponytail/4.7.0/`). Packaged simultaneously
  as a Claude Code plugin, a "pi" package (`pi.extensions` /`pi.skills` in
  package.json), and configs for `.cursor`, `.windsurf`, `.opencode`, `.kiro`,
  `.codex-plugin`, gemini-extension.json. Implication: same install path as
  caveman; no license or availability blocker.

- **None of the three are private/unpublishable.** All have public GitHub
  owners, MIT or Apache-2.0 license files present, and existing marketplace
  manifests. Nothing to flag.

### Part 2 — Fleet launcher

- **tmux is installed (3.6b) and is the most scriptable option with zero
  dynamic-parameter friction.** — VERIFIED (`tmux -V` on this machine).
  `new-session -d`, `split-window`, `send-keys` take literal shell strings —
  per-seat env vars (e.g. ccl's `CLAUDE_PEERS_MODEL`/`CLAUDE_PEERS_ROLE`) go
  straight into the command line at spawn time, no intermediate file.

- **Claude Code's own CLI already has a native tmux convention to imitate.**
  — VERIFIED (primary: `claude --help` on this machine): `--tmux` flag —
  "Create a tmux session for the worktree (requires --worktree). Uses iTerm2
  native panes when available; use `--tmux=classic` for traditional tmux."
  Implication: Patrol's launcher should follow the same fallback order
  (iTerm-native-panes → classic tmux) rather than inventing a new convention,
  for consistency with what users already expect from `claude -w --tmux`.

- **`claude agents` + `--bg`/`--background` is a first-class headless
  dispatcher, not a `claude -p &` hack.** — VERIFIED (primary: `claude
  agents --help`). Per-dispatched-session overrides already exist:
  `--model`, `--settings`, `--mcp-config`, `--strict-mcp-config`,
  `--plugin-dir`, `--permission-mode`, `--effort`, `--agent`, `--cwd`, plus
  `--json` for scripting and `--all` to include completed sessions.
  Implication: Patrol's "headless seat" support should be a thin wrapper that
  shells out to `claude agents` dispatch with per-seat args, not custom
  process/PID management — this is functionality Anthropic already built and
  maintains.

- **Warp has a real scriptable multi-pane launch path: YAML Launch
  Configurations + `warp://launch/<name>` URI scheme.** — VERIFIED (primary:
  docs.warp.dev/terminal/sessions/launch-configurations and
  docs.warp.dev/terminal/more-features/uri-scheme, fetched directly). Schema:
  windows → tabs (title, color, layout) → panes (cwd, split_direction,
  is_focused, nested panes) → commands (`exec: "<string>"`). Triggered
  headlessly via `open "warp://launch/<config-name>"` (optional
  `?new_window=true`).

- **Warp Launch Configs have NO per-pane `env` field and NO CLI/URI
  parameterization at launch time.** — VERIFIED (primary: same docs fetch,
  explicit) + corroborated by open upstream issues asking for exactly this
  (`warpdotdev/warp#12343` "Support opening Tab Configs from CLI with
  parameters", `#9083` "Expose Tab Configs via URI scheme / CLI for
  programmatic launch" — both still open). Implication: per-seat dynamic
  values (model, role, profile) must be baked into each pane's `exec` string
  at YAML-generation time — Patrol would need to write a temp YAML file per
  fleet run, then `open` it. Functionally similar total complexity to tmux
  (both end up constructing one shell command string per seat) but with an
  extra file-generation step and one extra process hop (`open` → Warp app
  parses YAML → spawns panes) versus tmux's direct `send-keys`.

- **No standalone `warp` CLI binary exists on this machine or on PATH** — only
  `Warp.app` + its registered `warp://` URL scheme (confirmed via
  `Info.plist` `CFBundleURLSchemes`). Scripting Warp means shelling out to
  `open "warp://..."`, not a dedicated CLI tool.

- **iTerm2 is not installed on this machine.** — VERIFIED (`mdfind` for the
  iTerm2 bundle ID returned nothing). AppleScript-driven iTerm control is a
  documented fallback pattern in general, but isn't testable here and isn't
  needed given `claude --tmux` already only *opportunistically* uses iTerm
  panes when present, falling back cleanly to classic tmux otherwise. Building
  a bespoke iTerm/AppleScript path for Patrol would duplicate what `claude
  --tmux` already handles for the worktree case, for a terminal the user
  (Warp on this machine) doesn't run daily.

- **ccl's plugin-toggle mechanism (`ccl regen`) is single-profile, not
  per-plugin-set.** — VERIFIED (read `~/.local/bin/ccl` directly): `regen`
  builds exactly one `lite-settings.json` with every plugin forced off. It
  does not currently support "seat A gets caveman+ponytail on, seat B gets
  neither" as distinct named profiles. Implication: this is new work for
  Patrol, not something to reuse as-is — the fleet config needs its own
  per-seat plugin list, materialized into a per-seat `--settings` JSON (or
  combined with per-seat `--plugin-dir` for session-scoped loads that don't
  touch global `enabledPlugins` at all).

## Contradictions & resolutions

- **rtk's measured savings**: 23% (this machine, brief) vs 60–90%/89%
  (public sources, multiple independent write-ups: rtk-ai.app, DEV Community,
  a Korean blog, a Medium post). Resolution: not a real contradiction —
  public figures are averaged over token-heavy commands (test runners, git
  status, cargo); local savings depend on the actual command mix on this
  machine. Both are individually plausible; neither should be quoted as a
  universal number in Patrol docs.

- **"Warp is scriptable" vs "Warp has no CLI"**: docs and community
  discussions (`warpdotdev/warp` Discussion #612, Issue #1550) show ongoing
  user demand for a proper CLI/scriptability layer, which reads as if Warp
  *lacks* automation — but the YAML+URI mechanism already does cover the
  fleet-launch use case, just via files+URI instead of a CLI verb. Resolution:
  both true simultaneously — Warp is scriptable for *static, pre-authored*
  layouts, not for *inline, ad hoc parameterized* ones, which is the specific
  gap Patrol would hit.

## Vocabulary

- "Launch Configuration" / "Tab Config" — Warp's terms for a saved
  window/tab/pane layout (YAML file under `~/.warp/launch_configurations/`).
- "background agent" / "dispatched session" — Claude Code's own terms
  (`claude agents --help`) for a headless, managed, non-interactive session.
- "profile" — ccl's term for a boot preset (`lite`/`peer`/`full`); Patrol's
  `patrol.yaml` should probably keep this word for continuity.
- "seat" — the brief's term for one fleet member; keep as the patrol.yaml
  vocabulary (matches how the D3 benchmark peer messages already use
  "executor seat").

## Dead ends

- Did not find a standalone `warp` CLI binary anywhere on this machine
  (checked PATH and `/Applications/Warp.app` internals) — so the Warp launch
  path could only be verified against official docs, not exercised
  end-to-end locally. If Patrol commits to Warp support, the YAML-generation
  + `open` round-trip needs a real local test before shipping.
- Did not find any evidence of a `warp-cli` package separate from the app
  (some terminals ship one); search results only surfaced the app's own URI
  scheme and in-app Command Palette / menu-bar access points.
- Did not pursue AppleScript/Terminal.app scripting in depth — no iTerm
  install to test against, and it isn't a build priority per the bottom line
  above; flagging only as unexplored territory if a future user's daily
  driver turns out to be iTerm or Terminal.app instead of Warp.

## Sources

Primary (read directly on this machine):
- `~/.claude/settings.json` (rtk hook wiring)
- `~/.local/bin/ccl` (existing single-seat launcher, profiles, regen)
- `~/.claude/plugins/cache/caveman/caveman/0d95a81d35a9/.claude-plugin/{marketplace,plugin}.json`, `LICENSE`, `package.json`
- `~/.claude/plugins/cache/ponytail/ponytail/4.7.0/.claude-plugin/{marketplace,plugin}.json`, `LICENSE`
- `claude --help`, `claude agents --help` (this machine's installed Claude Code CLI)
- `brew info rtk` (formula source, license, homepage)
- `/Applications/Warp.app/Contents/Info.plist` (URL scheme registration)
- docs.warp.dev/terminal/sessions/launch-configurations (fetched, YAML schema)
- docs.warp.dev/terminal/more-features/uri-scheme (fetched, URI format)

Secondary (search-surfaced, used for corroboration only):
- github.com/rtk-ai/rtk (upstream source confirmation)
- rtk-ai.app/savings, dev.to/arshtechpro (public savings figures — not verified independently beyond citation count)
- github.com/warpdotdev/Warp issues #8833, #12343, #9083, #1550, Discussion #612 (feature-request corroboration for Warp scriptability gaps)
