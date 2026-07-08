# Claude-Patrol

Ground-up rewrite of cross-terminal peer coordination for Claude Code.
Successor to claude-peers-mcp (patched as v0.2.0 in ~/claude-peers-mcp,
branch feat/coalesce-metadata-auth — the measured lessons live there and
in "~/Projects/Fable Hijack/orchestration.md").

Design pillars (hypotheses until research lands):
1. Peers beat subagents on marginal cost (~2.9x measured 2026-07-08) —
   Patrol makes standing fleets cheap to run and trivial to launch.
2. Boot cost is a first-class concern: per-seat profiles (model, plugins,
   MCP) built in, not bolted on.
3. One notification per poll batch, seats self-describe (role/model),
   broker authenticated. (Already proven in the v0.2.0 patch.)
4. Package as a Claude Code plugin if research confirms plugins can ship
   MCP + hooks + skills + commands together.

Status: research phase. See research/QUESTIONS.md.
