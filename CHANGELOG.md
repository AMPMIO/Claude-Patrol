# Changelog

## 0.2.4 — 2026-07-23

Fleet legibility + a second billing pool. Headless seats that draw the Agent-SDK
credit instead of the interactive subscription; per-wallet cost reporting; port
and file-ownership coordination so parallel seats stop colliding; a semantic seat
state model and a `/wait-for` primitive borrowed from herdr; and readable seat
handles replacing the random hex ids. 237 tests.

### Added
- **`backend: headless`.** A `claude -p --resume` adapter daemon (same shape as the
  codex seat). Pull-based by necessity — a headless session can't receive
  `claude/channel` pushes, so the adapter polls and drives one turn per message,
  settling each with `/ack`. Session-id lifecycle hardened: adopt-on-failure so a
  created session is never orphaned, an escape hatch after K failures so an
  un-resumable session can't black-hole the seat, and failed turns still bill toward
  thread retirement.
- **Billing-source attribution.** After the 2026-06-15 pool split, `claude -p`
  launches draw a separate Agent-SDK credit at API rates, not the interactive
  subscription. The cost ledger now tags every row `subscription | agent-sdk |
  external` (from the transcript `entrypoint`; codex is external), and `patrol
  status` reports the three wallets **separately — never summed**, because they bill
  different accounts. Codex spend has no transcript, so it shows `$—`.
- **Port broker.** `/claim-port` allocates ports from a range, persisted in the db
  (survives a broker restart), reaped when the seat dies — so parallel seats stop
  fighting over `localhost:3000`. Seat-side delivery of the port lands in 0.2.5.
- **File-ownership claims.** `patrol claim <path>` registers a seat as a path's owner;
  a competing claim is denied and names the holder. Advisory today (`patrol claims`
  / `patrol release`), enforcement hook later.
- **Seat state model** (`idle | working | blocked | done`). Self-reported via a
  `set_state` MCP tool; drives the coming dashboard and `/wait-for`. `blocked` is the
  question-inbox trigger.
- **`/wait-for`.** A caller long-polls until a target seat reaches any of a set of
  states, or times out — "builder waits until reviewer is done", so orchestration
  stops meaning hand-polling. `patrol wait <seat> --until done --timeout 60`. Holds
  no db transaction while waiting; a concurrent `/list-seats` stays responsive.
- **Readable seat handles.** The broker assigns a stable, readable handle at
  register — `builder` when unique, `patrol-builder` across projects, `verifier-mjji`
  only as a last resort. `patrol status`/`list`/`watch` show it; `patrol send builder`
  resolves it; `patrol rename` overrides it. The immutable hex id stays the internal
  key and a fallback, and the two namespaces are kept disjoint (a rename can't shadow
  another seat's id).

### Fixed
- Cost-attribution integration flake: the poll had a 15s deadline but bun's default
  5s per-test timeout killed it under load. Raised the test timeout above the
  deadline.

### Known limits (carried to 0.3)
- The v0.2.4 mutating routes (`/release-claims`, `/set-state`, `/claim-port`,
  `/rename`) trust `body.id` under the machine-wide shared secret — the same
  asserted-identity model as `/set-summary`, higher stakes. Folded into the
  roadmapped per-seat capability-token gate.

## 0.2.3 — 2026-07-23

Security + reliability wave. A whole-project Codex adversarial review returned 4
HIGH findings (three in the v0.2.2 codex adapter, one pre-existing broker-memory
risk); a second fable-review pass on the fixes found 5 more (2 blockers). All
closed. Lease/ack delivery pulled forward from v0.3 — it is finding #2's only real
fix and benefits every seat. 189 tests.

### Added
- **Lease/ack delivery.** `/poll-messages` now LEASES rows rather than marking them
  delivered; a message settles only on `/ack`. Unacked leases expire after
  `LEASE_TTL` (~15 min) and redeliver, so a consumer that crashes mid-batch does
  not silently drop work. Seat-server and the CLI ack after the notification is
  durably written; the codex adapter acks after a reply is sent.
- **`SeatSpec.sandbox`** (`read-only` | `workspace-write` | `danger-full-access`).
  Codex seats now default to **read-only** — a seat cannot touch files unless the
  yaml opts in, and a message can never escalate it (the adapter builds argv, not
  the model). Write-enabled seats additionally run a vetted `PreToolUse` deny hook
  (`src/codex/deny-hook.sh`) that blocks destructive commands by verb, not flag
  spelling. `danger-full-access` logs a startup warning: the OS sandbox boundary is
  off and only the best-effort backstop remains.

### Fixed
- **F1 — prompt injection / over-permissive codex sandbox.** Inbound message bodies
  are wrapped in an unforgeable per-message fence (random boundary) and labeled as
  untrusted data that cannot change a seat's role, sandbox, or safety rules.
- **F2 — crash-during-delivery data loss.** Fixed by lease/ack (above). Poison
  messages that deterministically fail no longer spam the requester or loop forever:
  bounded retry (3), then one "gave up" notice + ack so the message drains.
- **F3 — unbounded codex subprocess output.** stdout/stderr stream under an 8 MB
  cap; on overflow the child is killed and the turn fails while the daemon survives.
  A flooding turn is billed a floor estimate so it still drives thread retirement.
- **F4 — unbounded broker memory in the cost indexer.** `parseFileTail` reads in
  bounded chunks with a retained partial-line buffer; it never allocates a whole
  transcript tail in the broker process.
- **CPU bleed.** The cost indexer re-walked and re-tailed `~/.claude/projects`
  every 12 s forever, holding ~50 % of a core even after `patrol down`. Interval
  raised to 60 s and the tick skips entirely when no seat is live.
- **Deny-hook bypasses.** Long-form/mixed recursive-force removes, relative-path
  escapes, `+`-refspec and `--no-verify` force pushes, and interpreter-first /
  process-substitution pipe-to-shell all now denied.
- **Flaky cost-attribution test.** Polls on a wall-clock deadline instead of a
  fixed iteration count, which shrank silently under CPU contention.

### Note
- `package.json` was still 0.2.1 through the 0.2.2 release; corrected to 0.2.3.

## 0.2.2 — 2026-07-14

Codex seats: a standing `codex` thread that registers as a real Patrol seat and
answers messages from accumulated context, instead of a fresh codex subagent per
task. 173 tests.

### Added
- **`backend: codex`, the codex adapter seat.** A bun daemon that registers with
  the broker like any other seat and drives one persistent `codex exec resume`
  thread. Each inbound patrol message becomes exactly one codex turn; replies come
  back under the seat's own id. Turns are FIFO-serialized: a turn in flight makes
  later messages wait, so reply order and thread coherence hold. Concurrent `resume`
  on one thread was measured as safe (both turns append, nothing corrupts), so the
  serialization is a coherence choice rather than a lock.
- **Thread retirement on cumulative billed tokens.** Resumed turns resend a growing
  prefix, so a long-lived thread's cost climbs per turn. Past
  `CODEX_THREAD_RETIRE_BILLED_TOKENS` (default 300k) the next turn starts a fresh
  thread carrying a one-line handoff. The budget is a cost proxy: cumulative billed
  input, cached tokens included, not a live context-size ceiling.
- **Truncate + spill for oversize replies.** The broker caps a message at 8KiB and
  codex routinely returns more for code. Replies over the cap are truncated to fit
  and the full text written to `~/.claude-patrol/replies/<seat>/<msg>.txt`, with the
  path in the footer. Truncation is right even ignoring the cap: a 100KB dump inside
  a channel wake bills the receiver's whole context, whereas a path lets them opt in
  with a Read.
- **Poll backpressure.** A codex seat stops draining the broker while a turn is
  queued or running. A turn can hold the queue for the full 10-minute cap, and
  anything pulled would live only in RAM — lost if the seat dies. Undelivered work
  now stays broker-side, so a restart re-delivers it.

### Known limits (v1 of this feature)
- **Codex spend is not attributed.** `patrol status` shows no per-seat cost for a
  codex seat: attribution reads Claude Code session logs, and codex writes none.
  The spend is absent, not charged to some other seat. Parsing codex's own usage
  into the ledger is a v0.4 item.
- **Effort and sandbox cannot be set in `patrol.yaml`.** `SeatSpec` is frozen for
  v0.2, so a codex seat takes them from adapter defaults (`medium`,
  `workspace-write`) or from `CODEX_REASONING_EFFORT` / `CODEX_SANDBOX_MODE` in the
  environment it is launched from. Moving them into the yaml needs a contract change.
- **Replies over 8KiB are truncated**, not chunked. The receiver gets a spill path,
  not the whole reply inline.

### Changed
- **`patrol send --as <seat-id>` was cut.** It would let any local caller speak as
  any seat, which contradicts the trust model where the `[from …]` header is the only
  trusted identity — and the codex adapter never needed it, since it replies under its
  own real seat id. It returns in v0.3 alongside per-seat capability tokens, where
  ownership is proven rather than asserted.

### Also
- **Headless (`backend: bg`) seats never receive channel pushes.** The
  development-channels flag sits behind an interactive consent gate a headless session
  can't answer, so a bg seat registers and appears in `patrol status` but never wakes
  on a message. Use `tmux` for anything message-driven; `bg` is for seats that only
  need to exist. The real fix is plugin packaging (v0.3).

## 0.2.1 — 2026-07-10

A Codex adversarial review of v0.2 found three correctness holes in the
attribution/ledger paths; all fixed. Plus `patrol watch` — a live
fleet-overview TUI — and a rewritten benchmark claim grounded in repeat-run
forensics. 147 tests.

### Fixed (Codex review findings)
- **/observe-session could misattribute spend**: it bound by pid without
  requiring the run to be unbound, could overwrite a token-bound run, never
  checked whether another run already owned the posted session_id, and its
  cwd fallback guessed among multiple candidates. Now: a bound run is never
  overwritten (same-value re-post is an idempotent ok), a session owned by
  any other run is rejected, and the cwd fallback binds only when exactly
  one unbound live run exists — degrade over guess, everywhere.
- **`/list-seats` orphaned seat_runs**: it deleted a dead seat's row without
  setting `seat_runs.ended_at` or purging its undelivered messages, so a
  `patrol status` right after a seat died left the run open forever (still
  participating in token resolution and every future stats window). One
  `endSeat()` helper now serves list-seats, the stale sweep, and unregister.
- **Ledger missed in-place transcript rewrites**: the incremental indexer
  only re-parsed when a file shrank; a same-size rewrite (or a rewrite that
  then grew past the byte cursor) kept stale totals forever. The index now
  stores an anchor hash of the bytes just before the cursor and re-parses
  from zero whenever those bytes change. Known limit: a rewrite confined to
  >256 bytes before the cursor with an identical tail is still misread as an
  append — real Claude Code resume rewrites touch the tail, so this is
  theoretical.

### Added
- **`patrol watch`** — live fleet-overview TUI (ink 6 + React 19; inkui
  components vendored as source): fleet board across all projects (seat,
  role, model, cwd, live, spend, summary), a running inter-seat message log
  (auto-follow, scrollback), and an interactive send bar (Tab cycles the
  target seat, Enter sends as `cli`). Polls /log 1s, /list-seats 2s,
  /stats 5s; a dead broker shows a reconnect banner instead of crashing.
- **`/log` broker route** — message history with sender AND recipient
  role/model context (resolved from seat_runs, so dead seats still render);
  `after_id` cursor for cheap polling. Feeds the TUI.
- New runtime dependencies: `ink@^6`, `react@^19` (a deliberate amendment of
  the stdlib-only rule, for the TUI only).

### Docs / integrity
- Benchmark claim rewritten around the measured mechanism: a D1 repeat run
  + forensics showed ~80% of subagent-topology cost is standing context
  re-bought per spawn (~138k cache_write/spawn on a plugin-heavy config vs
  ~36k minimal). The config-matched −65% pair stands; dollar totals are now
  labeled mix-sensitive, with the per-spawn re-buy as the robust number.
  Both repeat runs recorded in the benchmark matrix (orchestration.md).

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
