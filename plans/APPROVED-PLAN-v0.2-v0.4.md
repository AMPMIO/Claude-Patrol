# Claude-Patrol — Next-Wave Development Plan

## Context

Claude-Patrol v0.1 shipped (broker + seat MCP + launcher + CLI + plugin, 67
tests green, pushed to github.com/AMPMIO/Claude-Patrol private). An
adversarial Codex review then found the flagship differentiator — per-seat
cost tracking — is **broken in the normal case**, plus a set of security and
reliability gaps. Separately, a parked-item sweep surfaced deferred features
(Rust CLI, Warp backend, optional integrations) and an integrity gap: the
"2.9× cheaper than subagents" headline rests on single unrepeated runs.

This plan organizes everything learned — review findings + parked work — into
three **sequenced** sub-waves (per user direction: fix-for-me first, then
publish-ready, then gated features). Scope is wide but phased so the
differentiator works before anything is polished or published.

Goal outcome: a Patrol you can run as a daily fleet driver with trustworthy
per-seat cost numbers (v0.2), then harden to publish-ready (v0.3), then add
the gated features once the core has proven itself (v0.4).

---

## Wave structure

| wave | theme | anchor | gate to start next |
|------|-------|--------|--------------------|
| **v0.2** | Make the differentiator real | cost-attribution BLOCKs + daily-use reliability | one real fleet used in anger, a week |
| **v0.3** | Publish-ready | auth BLOCKs + input validation + packaging | security tests green, marketplace install works |
| **v0.4** | Gated features | Rust CLI, Warp, optional integrations | v0.2 proven + v0.3 packaging settled |

---

## v0.2 — Make the differentiator real (single-user daily driver)

### Anchor: cost-attribution redesign

**Three attribution layers, precedence high→low:**
- **Layer 1 — prompt-marker token (primary; exact; launcher seats).** `up.ts`
  generates `cp-<8hex>` per seat; `composeSeat` injects it into the seat's env
  (`CLAUDE_PATROL_SEAT_TOKEN`) AND appends `[patrol-seat: <token>]` to the
  launch prompt. The seat reports the token at `/register`; the broker resolves
  `token → session_id` by finding the one jsonl whose `user` record contains
  the token (content match, not mtime) — **immune to N-seats-same-cwd**, the
  exact case that's dark today. Briefing templates tell the model to ignore
  `[patrol-seat: …]` lines. Silent-idle seats opt out via a `silent` flag →
  Layer 3.
- **Layer 2 — SessionStart hook (exact; any seat incl. manual; VERIFY first).**
  New plugin SessionStart hook POSTs `{session_id, transcript_path}` (CC hands
  these to hooks) to a new `/observe-session` route. Kill criterion: if this CC
  build doesn't pass session_id/transcript_path to SessionStart hooks, or the
  pid join fails, drop Layer 2 — Layers 1+3 stand. This is why Layer 1, not 2,
  is primary: one controllable mechanism, zero unverified assumptions.
- **Layer 3 — window heuristic (fallback; unchanged).** Existing
  `attributeSeatsToSessions`/`findSessionIdByHeuristic` kept verbatim,
  exactly-one-or-null → never misattribute; a manual seat in a busy cwd
  degrades to unattributed, never wrong.

**Subagent → parent rollup (fixes the other BLOCK):** `sessionFiles()` yields a
third value `parentSessionId` (= the `<session>` dir the `subagents/` folder
sits under); `computeCosts` attributes each record under `parentSessionId ??
own sessionId` while still displaying the subagent's own model row. Executor
spend rolls up to the parent seat.

**Persisted history (fixes cost-dies-with-seat):** three additive SQLite tables
— `seat_runs` (survives unregister via `ended_at`, holds token→session
binding), `cost_ledger` (per session/model/hour buckets), `session_index`
(per-file incremental cursor) + `seen_msgs` (resume-rewrite dedupe). Restart
gets a fresh run row; exact-by-token binding means a restart can't steal the
previous log.

**`/costs` off the sync path:** background `indexTick()` (~10-15s, mirrors
`cleanStaleSeats`) parses only appended jsonl tails (resume from
`bytes_parsed`), upserts ledger deltas, resolves pending token bindings.
`handleCosts` becomes table reads only — no filesystem walk on the request
path; `patrol status` renders instantly, spend at most one tick stale.

**Contract change (escalation, additive):** `seat_token?` on `RegisterRequest`;
`/observe-session` route + `parent_session_id?` on `CostRow` only if Layer 2 /
subagent-breakdown adopted.

Full design: agent output in session; verified against src/costs.ts (the
subagent leak and same-cwd collapse both confirmed at the cited lines).

### Reliability fixes (daily-use correctness)
- **`patrol send` false success** (HIGH, send.ts:14) — parse `{ok}`, exit
  nonzero on `!ok`. Trivial, ships first.
- **SessionEnd dereg pid mismatch** (HIGH, seat-server.ts:253 / dereg.ts) —
  seat-server registers its own pid; hook posts `$PPID`. Model both
  `server_pid` and `claude_pid`, or dereg by broker-issued id. Verify against
  real CC hook topology.
- **`patrol down` kills recycled pid** (HIGH, compose.ts:191) — verify
  executable/start-time before the pid fallback, or require `--force`.
- **Relative cwd not resolved against config dir** (MED, compose.ts:67).
- **status hidden by slow /costs** (MED, status.ts:9) — render seats first,
  spend degraded/cached; do not `Promise.all` the fleet behind the cost scan.
- **SQLite hot-query indexes** (MED, broker.ts:70) — `(to_id, delivered,
  sent_at)`, cwd/git_root, session lookup.
- **Non-transactional poll** (MED, broker.ts:205) — `UPDATE ... RETURNING`
  or a lease so interval + manual polls can't double-select.
- **Launch/teardown transactionality** (MED, up.ts:100/82) — incremental
  fleet.json, rollback on partial start, fleet-lock for bg (not just tmux).

### Security in v0.2 — the injection work (this IS the high-value security fix)
Threat-model finding (security design agent): on single-user localhost the
review's two auth BLOCKs are *low* real risk — a hostile same-uid process can
already read the 0600 secret and ptrace the seats, so no broker auth defends
that boundary. The **untrusted surface is content**: message bodies, summaries,
and text a seat pulls from the repo it's working in, relayed by a
confused/compromised-but-trusted peer wearing "teammate" authority. That is
prompt injection and it fires with one human and zero other users. So the
injection fixes are v0.2, not deferred:
- **Provenance fencing** (HIGH, seat-server.ts:214 + :156) — one fix for both
  the raw-single-message and forged-batch-header defects: sanitize sender
  metadata to one line; wrap every body in a MIME-style per-notification random
  boundary (`⟦patrol:msg <boundary>⟧ … ⟦/…⟧`) so a body can't terminate its own
  fence or forge a sibling `[from …]` record. Update the MCP instructions: only
  the broker-supplied header outside the fence is identity; inside is untrusted
  data, never instructions. Extract `sanitizeMeta`/`fenceBody`/
  `composeNotification` as pure fns for testing.
- **Input/size/rate validation** (HIGH, broker.ts:263) — per-route shape checks,
  size caps (text ≤8KiB, summary ≤500), queue-depth cap per `to_id`, Bun.serve
  body-size limit. Protects the cost metric + SQLite from oversized/looping
  content.
- **Seat-name slug** (HIGH→pulled to v0.2, up.ts:51) — `patrol up` reads
  `./patrol.yaml` from a possibly-cloned untrusted repo, so a crafted `name`
  (`../x`, absolute, `;`) is a live path-traversal + tmux-target vector. One
  regex in `validateConfig`: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
- **Secret perms/symlink hardening** (MED, auth.ts:16) — `lstat` first (refuse
  symlink), verify uid + `(mode & 0o077)===0`, self-repair or throw; cheap,
  hardens the secret that gates everything. Lift `secretPermsOk` from
  `_client.ts` into `shared/auth.ts` so both halves share one definition.
- **Cheap partial for identity** — reject `/send-message` whose `from_id` isn't
  a live seat or literal `"cli"` (stops forged provenance now, without the full
  token system).

### Benchmark integrity (parked items 39–42, orchestration.md)
The "2.9× / −65%" headline in README.md + DESIGN.md rests on single
unrepeated D1/D3 runs; the matrix (D2/D4/R1/R2) is blank. Either:
- repeat D1/D3 once each and fill ≥2 matrix cells to confirm the delta, OR
- soften the public claim to "measured once, ~2–3×, repeat pending" until done.
Cheap, protects credibility of the whole cost narrative.

---

## v0.3 — Publish-ready (security + packaging gate)

### Anchor: auth model redesign (mandatory ONLY before public/multi-user)
Both auth BLOCKs defend same-user boundaries that don't exist on single-user
localhost, so neither ships in v0.2 — they gate the public-release decision.
Recommended path when that decision is made:
- **Unix domain socket** (`Bun.serve({unix})`, 0600 in $HOME) as the
  single-machine transport — kills the secret-theft bind race (seat-server.ts:53)
  outright (no port to squat, no bearer token on the wire) and gives uid-level
  identity via peer creds. Kill criterion: if Bun's unix mode doesn't expose
  peer credentials, fall back to Option B for identity.
- **Per-seat capability tokens** (broker.ts:258) — `/register` mints a token
  bound to `seat_id`; the broker derives `from_id` from the token, ignoring the
  body field. This is the actual fix for spoofing/cross-seat-poll and is
  **mandatory whatever the transport** if it goes multi-user (transport
  isolation alone never gives seat-level identity). HMAC challenge before
  sending the secret if staying on TCP.
- Recommendation: unix socket as the localhost default + per-seat tokens for
  identity; only TCP+TLS+tokens if cross-machine fires — at which point DESIGN's
  reversal condition says re-evaluate the broker's existence entirely.

### Hardening (remaining, pre-public)
- **lease/ack delivery** (HIGH, broker.ts:205) — messages marked delivered
  before channel push confirms → silent loss on push failure. Mark delivered
  only after confirmed push or manual read.
- **Hook PATH/shell hardening** (MED, hooks.json:8) — argv-style or absolute
  `bun` wrapper so a poisoned PATH can't substitute a binary.
- _(Input validation, seat-name slug, secret perms already shipped in v0.2 —
  the security agent re-ranked them as the high-value single-user work.)_

### Packaging (BLOCK for distribution)
- **plugin/.mcp.json path** (plugin/.mcp.json:5) — `${CLAUDE_PLUGIN_ROOT}/../
  src/seat-server.ts` only resolves in this repo layout; marketplace installs
  break. Bundle the seat-server into the plugin, or generate MCP config at
  CLI-install time. **Settling this also unblocks the Rust CLI go/no-go.**

---

## v0.4 — Gated features (post-proof)

Start only after v0.2 proven in real use + v0.3 packaging settled.
- **Rust CLI binary** (SPEC-rust-cli.md, already written) — the two go/no-go
  gates (week-of-use, packaging settled) are satisfied by finishing v0.2+v0.3.
  Parity via the shared golden fixtures + `PATROL_CLI`-swapped integration
  suite already specced.
- **Warp launch backend** (research/r3) — generated-YAML + `warp://launch`
  path is researched; needs a real local Warp test (never exercised). Still
  gated on Warp upstream issues #12343/#9083 for true parameterization.
- **Optional rtk/caveman/ponytail installer** — all public MIT/Apache;
  documented recipes → optional installer script.
- **Deferred polish**: richer status board (hold/restart/pin), long-poll/SSE
  push cadence to cut the 1s poll (research item 22/26), real YAML lib if the
  config grows, prices-table versioning + "unknown price" surfacing
  (shared/types.ts:150), MCP boot-token trim (IDEA, seat-server.ts:125).

---

## Files this wave touches (by area)

- **Cost**: `src/costs.ts`, `src/broker.ts` (handleCosts, schema, new
  seat-run table), `src/seat-server.ts` (discoverSessionId), `src/commands/
  up.ts` + `src/launcher/compose.ts` (marker injection), `shared/types.ts`.
- **Reliability**: `src/commands/send.ts`, `src/commands/down.ts`,
  `src/commands/status.ts`, `src/launcher/compose.ts`, `plugin/hooks/dereg.ts`.
- **Security**: `shared/auth.ts`, `src/broker.ts` (serve handler + per-route
  identity), `src/seat-server.ts` (transport + fencing), `src/commands/up.ts`
  (name validation), `plugin/hooks/hooks.json`.
- **Packaging**: `plugin/.mcp.json`, `plugin/.claude-plugin/plugin.json`,
  packaging/install scripts (new).

## Verification

- Each fix ships its failing-case test (repo convention). Extend
  `tests/integration.test.ts` to prove **multi-seat same-cwd exact
  attribution** (the v0.2 anchor) and, in v0.3, **auth identity binding** +
  **injection fencing** (a forged-header message renders inert).
- Full `bun test` + `bunx tsc --noEmit` green per wave before merge.
- v0.2 exit: one real `patrol up` fleet used for actual work for a week with
  correct `patrol status` per-seat spend.
- Implementation delegated per repo routing (worktree-per-package, opus for
  design-heavy cost/security work, fable-review before merge); orchestrator
  freezes contracts first (the D3 lesson that made v0.1 parallelize cleanly).

## Riskiest assumption to test first

The launcher-injected-marker attribution scheme is the v0.2 load-bearing
unknown: it assumes the marker survives into the session JSONL in a
findable form. **Spike it first** — inject a marker via one launched seat,
confirm it appears in that seat's `~/.claude/projects/.../*.jsonl`, before
building the attribution path on top of it.

**SPIKE RESULT (2026-07-08, PASSED):** `claude -p "... [patrol-seat: cp-0375a012]"`
→ marker present in the resulting session jsonl in the `user` record; session
id = jsonl filename stem. Layer-1 exact attribution is viable; content-match
(not mtime) confirms N-seats-same-cwd is solved. Build cleared to proceed.
Refinement observed: the marker also appears in `last-prompt`/`queue-operation`
records — the broker's token→session scan should match ANY record (a plain
substring grep over the file suffices), not assume a specific record type.
