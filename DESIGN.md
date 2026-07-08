# Claude-Patrol — architecture decisions

2026-07-08. Synthesized from research/r1–r3 (evidence lives there) plus
measured benchmarks in "~/Projects/Fable Hijack/orchestration.md".
Every decision below carries its kill criterion; re-litigate only when one fires.

## Premise (confirmed, with reversal condition)

Independent standing terminal seats, coordinated by a local broker. This is
where the measured cost edge over subagent spawning lives (~2.9× on single
unrepeated runs, one per topology — repeat + matrix cells pending, see
orchestration.md items 39–42 in the Fable Hijack repo), and it is
exactly what first-party Agent Teams does NOT do (session-scoped,
lead-spawned; Anthropic issue #28300 requests our model = unshipped).
**Reverses if:** Anthropic ships persistent cross-session teams — then Patrol
pivots to the launcher + cost-tracking layer on top of native transport, and
the broker retires.

## D1 — Transport: minimal MCP + CLI for everything else

The `claude/channel` push is the only way to wake an idle session (R1;
hooks fire on lifecycle events only). So each seat runs a thin MCP server
whose ONLY jobs are: register, poll broker, push coalesced notifications.
All active verbs — send, list, summary, status — move to a CLI (`patrol
send`, via Bash), shrinking per-seat MCP schema payload to ~nothing (fits
the measured boot-cost findings; also makes rtk proxying apply for free).
- Losing option: full MCP toolset (status quo) — rejected: schema payload on
  every seat, no CLI reuse for humans/scripts.
- **Kill criterion:** channel capability breaks/changes in a CC release →
  fallback is a check_messages MCP tool + UserPromptSubmit hint hook;
  degraded (no mid-idle wake) but functional.

## D2 — Runtime: all-Bun, one language

Seats must be JS (MCP SDK + channel), and seats are the footprint
(measured: ~40MB × N seats vs broker 32MB). A Rust/Go broker saves ~5%
total while doubling maintenance for a solo dev.
- **Kill criterion:** seat RSS >100MB at 10 seats, or bun-install friction
  becomes the top adoption complaint → rewrite broker+CLI in Go (bounded:
  ~300 lines, HTTP+SQLite), seats stay Bun.

## D3 — Packaging: plugin + daemon dual-shape

One CC plugin ships MCP wiring + hooks + skills + commands (verified
possible in R2 from local plugin structures); the broker daemon + CLI ship
as npm package/binary because a plugin cannot host an always-on process.
Same dual shape cc-fleet proved. Marketplace distributes the plugin;
`patrol doctor` checks daemon health.

## D4 — v0.1 scope (build order)

1. **Broker v3** — port the proven v0.2.0 patch (auth, coalescing,
   role/model metadata, sender-join, purge) from claude-peers-mcp; add
   per-seat token/cost columns fed by session-jsonl parsing (token-audit.py
   logic, subagents dir included — the measurement bug stays fixed).
2. **Launcher** — `patrol up` reads patrol.yaml (seats: role, model,
   profile, cwd): tmux backend for visible seats (`--tmux` convention),
   `claude --bg` / `claude agents` for headless ones (verified flags).
   Per-seat plugin SETS (R3 gap: today's ccl is all-or-nothing).
   Correct-boot guard built in: a seat never boots without an explicit
   model (the measured $3.6–4.9/seat Fable-default leak).
3. **`patrol status`** — fleet board in the terminal: seat, role/model,
   summary, last-seen, spend. Borrow cc-fleet's board+spend-columns idea,
   don't reimplement its provider-swap.
4. **Plugin half** — skills: orchestrator briefing template per role
   (delegation-brief-derived); commands: /patrol-status, /patrol-brief;
   hook: SessionEnd dereg.

**#1 differentiator = per-seat cost tracking** (R2: no third-party peer
tool has it; messaging and roles are table-stakes — agmsg has roles and
971★). Coalescing near-unique. Ship 1–3 before any polish.

NOT in v0.1: cross-machine transport, Warp backend (second-tier, needs
generated launch YAML — v0.2 candidate), GUI board, voice, bundling
rtk/caveman/ponytail (they stay OPTIONAL documented recipes — all public
MIT/Apache; an installer script may come later).

## Riskiest assumption + first test

`claude/channel` is research-preview. It's the load-bearing unknown, so it
gets tested FIRST: v0.1 step 0 is a 30-line spike proving push works under
the current CC release (claude-peers already demonstrates it daily, so this
is a re-verification, not a gamble).

## Trade-offs (said out loud)

- **Sacrificed:** cross-machine support and Warp-native UX in v0.1.
  Acceptable: solo-machine is the proven use case; tmux covers visible
  seats today. Reverses if: a second machine enters the workflow, or Warp
  ships CLI/URI parameterization (open upstream issues).
- **Sacrificed:** language-level footprint optimum (Rust). Acceptable:
  measured 5% delta. Reverses if: D2 kill criterion.
- **Sacrificed:** building on agmsg (971★, active) instead of ground-up.
  Acceptable: the moat is the combination (broker + roles + cost +
  coalescing + launcher); bolting cost-tracking onto agmsg means living in
  someone else's architecture for the flagship feature. Reverses if: agmsg
  ships cost tracking before Patrol v0.1 lands.
