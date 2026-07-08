# Build contracts — v0.1 (read before writing code)

Interfaces are frozen in `shared/types.ts` (orchestrator-owned). File
ownership is exclusive per work package; needing a file outside your set is
an escalation, not an edit.

## Work packages

| WP | owner branch | owns |
|----|--------------|------|
| W1 broker+seat | `w1-broker` | `src/broker.ts`, `src/seat-server.ts`, `src/costs.ts`, `shared/auth.ts`, `tests/broker.test.ts`, `tests/costs.test.ts` |
| W2 launcher | `w2-launcher` | `src/commands/up.ts`, `src/commands/down.ts`, `src/launcher/*.ts`, `src/profiles.ts`, `patrol.yaml.example`, `tests/launcher.test.ts` |
| W3 cli+plugin | `w3-plugin` | `src/commands/status.ts`, `send.ts`, `list.ts`, `doctor.ts`, `plugin/**`, `tests/cli.test.ts` |

Shared, already scaffolded by orchestrator: `shared/types.ts`, `src/cli.ts`
(thin dispatcher — auto-loads `src/commands/<name>.ts`, each command module
default-exports `(args: string[]) => Promise<number>`).

## Rules of the road

- Bun + TypeScript, stdlib-first; the ONLY runtime dependency allowed is
  `@modelcontextprotocol/sdk` (W1). YAML: write a minimal parser or use
  `Bun.YAML` if available — no `js-yaml` (check first; escalate if neither
  works, do not add deps silently).
- Every WP ships runnable tests (`bun test`) covering its failure cases.
  Untested logic is a draft. `bunx tsc --noEmit` must pass.
- Broker semantics: port the PROVEN patterns from
  `~/claude-peers-mcp` branch `feat/coalesce-metadata-auth` (auth header,
  poll-batch coalescing → ONE channel notification, sender-context JOIN,
  additive migrations, delivered-purge, stale-PID cleanup). Do not
  reinvent; improve names.
- Costs (W1 `src/costs.ts`): parse `~/.claude/projects/*/*.jsonl` AND
  `~/.claude/projects/*/*/subagents/*.jsonl`; dedupe on (sessionId,
  message id); price via `PRICES`. Attribution: exact when a seat
  registered a session_id; else by project-dir + time-window overlap,
  marked `seat_id: null` → "unattributed".
- Seat boot guard (W2): refuse to launch any seat whose spec lacks
  `model`. Refuse `backend: current` combined with a profile (can't
  re-profile a running session).
- tmux backend: one session `patrol`, one window per seat, window name =
  seat name; `send-keys` the composed `claude ...` command. bg backend:
  `claude --bg` with per-seat flags; record what `claude agents --json`
  reports for teardown.
- Commit small on your branch with prefix `W<n>:`. Never touch main.

## Done per WP

Tests pass + tsc clean + a 5-line completion report (what shipped, what
was cut, the one thing to review hardest) messaged back to the
orchestrator seat. Orchestrator reviews (fable-review bar), merges to
main, runs cross-WP integration.
