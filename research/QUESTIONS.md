# Open design questions (research phase, 2026-07-08)

R1 — runtime + transport (research/r1-runtime-transport.md)
- Does peer messaging still need an MCP server, or does Claude Code's
  native 2026 multi-agent surface (teams, SendMessage, named agents)
  cover independent-terminal messaging?
- If MCP is needed for push, what is the minimal MCP surface?
- Language/runtime for broker + per-seat server + CLI: Bun/TS vs Go vs
  Rust. Metrics: RSS per seat, cold start, single-binary distribution.

R2 — landscape + features (research/r2-landscape-features.md)
- What do claude-squad / claude-swarm / cc-fleet / tmux orchestrators do,
  what's missing, what earns adoption?
- Ranked feature list: mission board, cost tracking, seat health,
  briefing templates, fleet config. Evidence per feature.
- Packaging: can a CC plugin ship MCP + hooks + skills + commands?

R3 — integrations + launcher (research/r3-integrations-launcher.md)
- rtk / ponytail / caveman as optional installs: mechanics, licenses,
  what each buys (cite measurements).
- Single-terminal fleet launch: tmux / Warp / iTerm mechanics, per-seat
  profiles (see ~/.local/bin/ccl), fleet config file format.
