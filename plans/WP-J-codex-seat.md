# WP-J — codex adapter seat (v0.2.2)

Executor brief. Read fully before any code. Orchestrator (seat 9geply1e) owns
merges; you own the branch. Route the BULK of implementation through codex
(`codex exec -m gpt-5.6-terra -c model_reasoning_effort="high"`) — you drive,
judge, and commit; codex writes. Escalate to the orchestrator via
`patrol send 9geply1e <msg>`, don't grind.

## Context
Patrol v0.2.1 is live (broker :7900, seats, cost ledger, watch TUI). The next
differentiator: a STANDING codex instance as a first-class seat — message it,
it answers from accumulated context; no per-task codex spin-up, no sonnet
wrapper. Contract frozen on main: `SeatSpec.backend` now includes `"codex"`
(guarded with a throw in validateConfig — you replace that guard with the real
path). Spike verified (2026-07-11): `codex exec` seeds a session, `codex exec
resume <id|--last> "<prompt>"` continues it WITH memory; fresh spawn ≈ 15.8k
tokens; resumed turns resend a growing prefix — hence thread retirement below.

## Step 0 — finish the spike (before building)
Two unknowns the adapter design depends on. Answer with evidence:
1. Session-id capture: how does a script reliably get the new session id from
   `codex exec`? (Try `--json`; else parse output; `--last` is the fallback
   but racy if other codex runs happen on the machine — measure whether ids
   appear in ~/.codex/sessions and can be diffed.)
2. Concurrency: two `codex exec resume` on the SAME id at once — error, queue,
   or corruption? (Cheap test, read-only sandbox.)
Report findings to the orchestrator BEFORE the build if either answer forces a
design change; else fold into the final report.

## Build
Worktree: `git -C ~/Projects/Claude-Patrol worktree add ~/Projects/Claude-Patrol-j -b v022-codex-seat main` + bun install.
Owned files: src/codex-seat.ts (new), src/launcher/compose.ts, src/commands/up.ts,
src/commands/send.ts, src/commands/_client.ts (only if --as needs it),
tests/codex-seat.test.ts (new), tests/launcher.test.ts, tests/cli.test.ts.

1. **src/codex-seat.ts** — the adapter daemon (mirror seat-server.ts's broker
   patterns: brokerFetch, ensureBroker, register/heartbeat/poll/unregister):
   - argv/env: cwd, role, model label (CLAUDE_PATROL_MODEL = the codex model,
     e.g. gpt-5.6-terra), effort, sandbox mode (default workspace-write).
   - Registers as a normal seat (no seat_token, no session_id — codex has no
     CC transcript; its SPEND stays unattributed in v0.2.2, documented).
   - Poll loop (1s, in-flight guard, 2.5s timeouts — copy the house pattern).
   - Inbound message → ONE codex turn, strictly serialized (FIFO queue; a
     turn in flight means later messages wait — reply order preserved):
     first turn `codex exec --skip-git-repo-check -m <model> -c
     model_reasoning_effort="<effort>" -s <sandbox> --cd <cwd> "<prompt>"`,
     capture session id (per step 0); later turns `codex exec resume <id> …`.
   - Reply: `patrol send`-equivalent POST /send-message with from_id = OWN
     seat id (broker validation accepts live seat ids), to_id = the inbound
     message's from_id (skip replies to "cli" senders? NO — reply to "cli"
     fails (not a seat); instead when from_id is "cli", still run the turn
     and record the answer in the seat summary tail — the human sees it in
     watch; document this).
   - Thread retirement: parse "tokens used" from codex output, accumulate;
     past CODEX_THREAD_RETIRE_TOKENS (env, default 300000) start the NEXT
     turn fresh with a one-line handoff ("continuing prior thread; summary:
     <last reply's first 500 chars>"). Log retirement to stderr.
   - Failure posture: codex exec nonzero/timeout (10min cap per turn) →
     reply with the error text, keep the daemon alive; broker down → keep
     polling (house pattern); SIGTERM → unregister + exit 0.
2. **compose.ts** — REPLACE the validateConfig codex-guard with a real path:
   backend "codex" seats compose argv ["bun", <abs path to codex-seat.ts>,
   ...flags] and launch in a tmux window like tmux seats (visible logs,
   `patrol down` kills them with the session). No claude flags, no marker, no
   mcp config for these seats. Keep composeSeat pure; assert exact argv in
   launcher.test.ts.
3. **up.ts** — route codex-backend seats through the tmux launch path with the
   adapter argv.
4. **send.ts `--as <seat-id>`** — sets from_id (broker already validates it
   must be a live seat or "cli"). One flag, one test: --as with a live seat id
   passes through; --as with garbage exits 1 with the broker's error.
5. **Tests** — NO real codex calls: stub `codex` with a fake executable fixture
   (script that echoes canned output incl. "tokens used" lines and a fake
   session id) on PATH. Unit-test: queue serialization (two rapid messages →
   two sequential turns, order kept), session-id capture, retirement trigger
   at the token threshold, error-turn reply, cli-sender handling. Launcher:
   codex argv composition + the guard's removal (config with backend codex now
   plans instead of throwing).

## Done looks like
bun test fully green + bunx tsc --noEmit clean; "J:" commits on v022-codex-seat;
report via `patrol send 9geply1e`: step-0 answers with evidence, what shipped,
what codex wrote vs what you wrote/fixed (be specific — this wave also tests
codex-as-executor), the one thing to review hardest. The orchestrator sends
the reviewer seat over your diff before merge.

## Do NOT
Touch shared/types.ts (frozen), src/broker.ts, src/costs.ts,
src/seat-server.ts, src/tui/**, plugin/**; add npm deps; merge or push; run
real codex in tests; leave adapters/tmux running after your own manual tests.

## Escalate if
Step-0 finding invalidates the single-thread design; codex sandbox flags
can't confine writes to the seat cwd; the 8KiB message cap makes long codex
replies undeliverable (propose truncation+file spill, don't invent silently).
