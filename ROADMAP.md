# Roadmap

The long version. [`README.md`](README.md#roadmap) carries the one-line summary of
each release; this file says *why* each one existed and what it cost. For the
line-item "what changed", see [`CHANGELOG.md`](CHANGELOG.md). For the decisions with
their kill criteria, see [`DESIGN.md`](DESIGN.md).

**No dates.** Sequenced, not parallel — a version has to prove itself in real use
before the next one starts.

---

## How this roadmap is decided

Three rules, applied to every candidate feature:

**1. The verb budget is real.** Patrol publishes its command count (19) so it can be
watched. The field's cautionary tale is a competitor whose own docs disagree on its
tool count — 87, 171, and 210 in three places. A small memorizable surface is the
edge; every new verb has to displace something or justify itself. Several good ideas
below are deferred purely on this basis, and that is recorded rather than hidden.

**2. Steal mechanisms, refuse categories.** The competitive sweep
([`research/`](research)) exists to find mechanisms worth copying and, more
usefully, categories worth refusing. Patrol has declined a hosted backend, a kanban
weight class, a container substrate, and a k8s runtime — each because a competitor is
already dying or bloating in that direction.

**3. Every claim gets falsified before it ships.** The 2026-07-27 re-sweep killed
three claims this project had been making, including one on the README's front page.
That is the process working, not the process failing.

---

## Shipped

### v0.1 — the thing that did not work

Per-seat cost attribution, and it broke on the case that matters: several seats
working in the same repo. Sessions could not be told apart, subagent transcripts were
excluded, and real runs were undercounted by 63%. Everything from 0.2 onward is
downstream of fixing that properly.

### v0.2.0 — the rewrite

Ground-up, informed by running [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp)
in anger and patching it. Authenticated broker, coalesced push, the three-layer cost
attribution chain (launch-token content match → SessionStart hook → window heuristic
that reports `unattributed` rather than guessing), and the launcher.

The security model was set here and has not moved: **content is the adversary**. A
single user on a single machine, where the untrusted input is what a model reads, not
who connects.

### v0.2.1 — the first adversarial review

Codex review findings, fixed. This established the pattern the project has used ever
since: ship, then have an independent reviewer attack it, then fix what it finds
before adding anything new.

### v0.2.2 — codex seats

`backend: codex` boots an adapter that keeps one `codex exec resume` thread alive and
registers as an ordinary seat.

**What was cut here and why it matters:** `patrol send --as <seat>`. It would have
been a one-flag provenance-forgery primitive — anyone could speak as any seat — which
contradicts the trust model where the `[from …]` header is the only trusted identity.
It returns in v0.3 with capability tokens, where ownership is *proven* rather than
asserted.

### v0.2.3 — delivery that survives a failure

Lease/ack delivery: `/poll-messages` leases a batch, `/ack` settles it, unacked leases
redeliver. A live seat whose push failed stops silently dropping work.

Codex seats hardened into the three-layer model described in the README: read-only
sandbox by default, a command-veto `PreToolUse` hook for write-enabled seats, and an
unforgeable fence around inbound message bodies.

### v0.2.4 — built on the fleet, by the fleet

The first version Patrol was used to build. Five things landed in parallel across
standing seats:

- **`backend: headless`** — a `claude -p --resume` adapter. Pull-based *by necessity*:
  a headless session cannot receive `claude/channel` pushes (the consent gate cannot
  be answered without a terminal), so the adapter polls and drives one turn per
  message. Verified live 2026-07-10.
- **Billing-source attribution.** After the 2026-06-15 split, `claude -p` launches
  draw a separate Agent-SDK credit pool rather than the interactive subscription.
  `patrol status` reports subscription / agent-sdk / external as three totals, **never
  summed**, because they bill different accounts.
- **Port and file-ownership claims** — parallel seats stop fighting over
  `localhost:3000`, and a competing path claim is denied by naming the holder.
- **Seat state + `/wait-for`** — seats self-report `idle | working | blocked | done`,
  so a script can `patrol wait <seat> --until done` instead of hand-polling.
- **Readable handles** — `patrol send builder` instead of random hex.

### v0.2.5 — the human's view

- **`patrol dash`** — a broker-served command center: question inbox (`/ask` surfaces
  every open question in one place, you answer, the broker routes it back), fleet
  board, comms audit log.
- **`patrol cockpit`** — the whole fleet in one tmux window. Stolen from herdr's "real
  pane views, not a wrapped interpretation": these are the actual terminals joined in,
  not a rendering of them.
- **`patrol init`** — a wizard that writes and gitignores `patrol.yaml`. `--ai` runs a
  one-shot `claude -p` over the repo and your stated goal to *recommend* a fleet. That
  run is deliberately isolated — empty MCP config, no tools, temp cwd so no project
  `CLAUDE.md` or hooks load, repo signals fenced as untrusted — so a hostile repo
  cannot steer it.

### v0.2.6 — competitor steals, chosen against the verb budget

- **Budget alerts.** A seat crossing its `budget_usd` pings the orchestrator exactly
  once. Observe-only: Patrol reports spend, it never gates a model or stops a seat.
- **`patrol worktree` + `patrol checkpoint`** — the task-worktree loop in two verbs.
  The seat is never pinned to a tree; it picks a task tree up and puts it down. Merge-
  back runs inside a *throwaway integration worktree*, so it never mutates a checkout
  another seat may be mid-build in.

Deferred here, purely to hold the verb count: status-change hooks, gate-first
validation, heuristic state fallback, seat-side port delivery. All four are still
open and tracked.

### v0.2.7 — eight findings

A Codex adversarial review of 0.2.5/0.2.6: 1 critical, 4 high, 3 medium, each verified
against the code before being fixed.

The critical one is worth stating plainly: **`GET /dashboard` was unauthenticated and
embedded the full broker secret in the page.** It is now nonce-gated behind a loopback
Origin/Host check, and that nonce authenticates the read routes plus `/answer` only.

### v0.2.8 — the review of the fixes

A second pass, aimed at 0.2.7's own work. Three fixes were incomplete rather than
closed, and one was a regression 0.2.7 had introduced: a recovery path could put two
seats in one worktree. Checkpoint grew a third fence binding both the branch tip and
symbolic HEAD.

The lesson recorded from this round: *a fix is not a fix until something adversarial
has looked at the fix.*

### v0.2.9 — checkpoint stops racing the seat

The hardest correctness problem in the project so far, and it took four review rounds
to admit the real shape of it:

**Detection cannot win a race against a concurrent writer.** Checkpoint's fences kept
being asked to *detect* a seat that was still working. The final fence could not even
read the seat's HEAD, because by then the worktree was gone.

So the seat is **quiesced** instead of watched. Checkpoint takes a lease and writes a
lease file; the seat's `PreToolUse` guard hook denies mutating tool calls while that
file is live; checkpoint proves the branch tip has stopped moving; only then does it
merge. The hook **fails open on every error path** — a wedged fleet is worse than a
missed fence — and the three fences stay in place as the detector for everything the
lease cannot cover.

A seat with no guard hook (`codex`, `headless`) is refused unless you pass `--force`.

### v0.3.0 — identity

Three separate pressures converged on one missing concept.

**Fleets.** The tmux session name was the hardcoded string `"patrol"`, so `patrol down`
in *any* project killed *every* project's seats. One fleet per machine, enforced by
accident. Sessions are now `patrol-<fleet>`, every internal tmux target uses `=` exact
match, and handle uniqueness moved from machine-wide to per-fleet. Ports stay
deliberately machine-global — they are a real OS resource, and per-fleet ranges would
hand two projects the same 9000.

**Capability tokens.** Three consecutive reviews landed on the same class of finding:
routes trusted `body.id`. A seat could spoof another seat's state, release its claims,
ack its mail, or burn ports charged to it. Tokens are now minted at `/register`, stored
hashed, and enforced by a deny-by-default route allowlist with server-side fleet
confinement — 403 for the wrong seat, 401 for an invalid token. The CLI a seat is told
to use authenticates *as that seat*.

**Crash redelivery**, which was gated on the above: a restarted seat re-claims its
prior identity and its unacked mail is redelivered instead of purged.

Plus `patrol send --brief <path>`, which hands over a pointer rather than pasting a
brief — a multi-KB brief pasted into context is re-billed on every subsequent turn.

**What this version does NOT buy, stated plainly:** it does not contain a compromised
seat. See [the caveat](README.md#status-and-caveats). That is a design ceiling, not a
missing patch, and closing it is a v0.4 item.

---

## Next

Tracked as issues in the **CLAP** project. The themes:

### Correctness the lease cannot reach

- **Prove the guard fired.** `guarded` proves a hook is *installed* — it cannot prove
  the hook *ran*. At registration a seat verifies only what it can see locally: the
  lease path is absolute, the guard script exists, the lease directory is writable. It
  cannot verify that Claude loaded the settings overlay or will honor a deny. Closing
  this needs the hook itself reporting back. **This is the largest remaining gap in
  the lease.**
- **Background processes escape the lease.** A watcher or dev server started *before*
  the lease keeps writing, and no `PreToolUse` hook can see it.
- **Harden worktree removal** with an independent orphan-gitdir proof, so checkpoint
  never trusts a path record it cannot verify is really a worktree of this repo.

### Delivery that does not depend on a research preview

Patrol's push path is `claude/channel`, a Claude Code **research preview** behind
`--dangerously-load-development-channels`. Two consequences today: `bg` seats never
receive pushes, and an API change degrades delivery to the polling fallback. A PTY
prompt-injection fallback (the mechanism Orca uses for all delivery) removes that
single point of failure.

### The unit operators actually think in

`patrol status` reports dollars. On a subscription-billed fleet, dollars are the wrong
unit — the 3pm question is *"is `builder` about to get cut off, and when does its
window reset."* Rate-limit headroom, read from the OAuth usage endpoint with a
transcript fallback.

### Continuity across a restart

A standing seat's value is accumulated judgment, and today that dies with the process.
Crash redelivery restores a restarted seat's *mail*; these restore its *reasoning*:

- **`patrol recall <seat>`** — `seat_runs` already binds seat → session id for cost
  attribution, and that row outlives the seat. So Patrol can hand a returning seat its
  own prior session ids, and — if [ctx](https://github.com/ctxrs/ctx) is installed —
  the commands to search them. **Pointers only**: prior transcripts are never injected
  into a fresh prompt, because that is both a token bomb and an injection surface. ctx
  stays optional; Patrol degrades silently without it.
- **Handoff receipts (evaluation).** `--brief <path>` fixed the token cost of a brief.
  What a path cannot do is prove the seat read it, or propagate a correction when a
  brief is amended mid-wave — both cost real rework during the 0.2.x waves. A
  reference layer like [waggle](https://github.com/modiqo/waggle) closes exactly that
  (receipts with coverage, `supersede` with lineage). Being evaluated **for those two
  properties only** — the token-saving argument is already handled by the pointer, and
  waggle's own benchmark puts a plain path within six points of the full mechanism.

### Real containment

The current boundary constrains accidents, adapter seats, and any caller without a
shell. It cannot stop a seat that has Bash, because that seat can read the operator
secret file directly. Closing it requires the secret to be unreadable by seats: **per-
seat OS users**, or replacing the TCP listener with a **unix socket authenticated by
peer credentials**.

The unix socket was explicitly declined for v0.3 and the reason is worth keeping: the
dashboard is a browser page, and a browser cannot reach a unix socket. Shipping it
naively kills the command center. That is a design problem to solve, not a patch to
apply — which is why "add more bearer-token plumbing" is the wrong answer and is
called out as such on the issue.

### Deferred, still open

Status-change hooks (run a command on a seat state transition — the cheapest general
automation surface available, since the broker already sees every transition and does
nothing with them). Gate-first validation (a task carries its acceptance criterion
*before* work starts, rather than a gate supplied at checkpoint time by whoever is
checking in). Heuristic state fallback, strictly as a fallback and never an override,
for seats that never self-report. Seat-side port delivery. Dashboard kanban populated
from the worktree table. Plugin packaging, so a cloned install resolves its own paths
and the guard hook becomes installable for hand-launched seats.

### Project-level telemetry → the self-improving loop

The broker already sees every message, per-seat spend across three wallets, state
transitions, worktrees, claims, leases, and the cache re-encode tax. It keeps none of
it as a record you can reason about later. Rolling those into durable per-project
session records is also **the only honest way to test Patrol's own thesis** — the
standing-seats benchmark is 1–2 runs per cell with three caveats attached, and one of
those caveats is a cost standing seats *create*. Telemetry over real ongoing work is
what replaces a one-off measurement with evidence.

Hard requirement: **schema first.** Data gathered without one is unminable six months
later, which is the entire point.

Local only. No cloud, no account, no phoning home — telemetry is exactly where
projects break that promise.

---

## v0.4 — after it has proven itself

A Rust CLI. SSE or long-poll replacing the 1s poll. Codex cost parsing, so non-Claude
seats get their own per-seat dollar figure (v0.2.4 tags *which pool*, not codex's own
number). A retention sweep for the ledger. Per-task cost tags. A Warp launch backend.
Real containment, per above.

---

## Watched: the reversal condition

`DESIGN.md` states the premise's kill criterion up front rather than hiding it:

> **Reverses if:** Anthropic ships persistent cross-session teams — then Patrol pivots
> to the launcher + cost-tracking layer on top of native transport, and the broker
> retires.

This outranks every competitor in the matrix. It has not fired: first-party Agent
Teams is session-scoped and lead-spawned, and Anthropic issue **#28300** requests
exactly the persistent cross-session shape that would trigger it. That issue is
tracked.

A roadmap that cannot say what would end the project is a sales document.
