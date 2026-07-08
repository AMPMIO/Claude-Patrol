# Spec: `patrol` CLI as a single Rust binary

Status: SPEC ONLY — build is gated (see "Go/no-go"). 2026-07-08.

## Why Rust here and nowhere else

DESIGN.md D2 killed a Rust *broker* (seats are JS-bound and dominate
footprint; broker saves ~5%). The CLI is the one component where Rust earns
its keep, for a different reason entirely: **distribution**. The CLI is what
non-Patrol users touch first (`brew install` / download → `patrol up`), and
today it requires a working bun on PATH. A static binary removes the last
install prerequisite for the human-facing half while broker + seats stay
Bun (started by the launcher, which can check for bun and say so — one
dependency, checked in one place, instead of every user command needing it).

Secondary wins, real but not decisive: ~5ms cold start (matters for
`patrol status` in a prompt/statusline), no JS runtime spin-up per CLI call.

## Scope

In: the six verbs — `up`, `down`, `status`, `send`, `list`, `doctor` — plus
`--help`/`--version`. Feature-parity with `src/cli.ts` + `src/commands/*`.

Out (stays Bun): broker daemon, seat MCP server, plugin half. The binary
TALKS to the Bun broker over the same authenticated HTTP API; it never
embeds one.

## Crates (minimal, boring)

| need | crate | note |
|---|---|---|
| args | `clap` (derive) | the one heavyweight allowed; standard |
| HTTP | `ureq` | sync, tiny, no tokio — the CLI is request/response |
| JSON | `serde` + `serde_json` | |
| YAML | `serde_yaml` | replaces the hand-rolled TS subset parser — strictly MORE yaml than TS CLI accepts; parity risk is one-directional and benign |
| errors | `anyhow` | binary, not a library |

No tokio, no reqwest, no sqlite (broker owns the DB). Target: <3MB stripped
static binary, <10ms `patrol list` against a warm broker.

## Parity contract (the load-bearing part)

Two implementations of one CLI drift unless parity is mechanical:

1. **Shared golden fixtures.** `tests/golden/` holds JSON cases:
   `{seatSpec, installedPlugins} → {argv, env}` for composition, and
   `{seats, costs} → rendered board` for status. The TS tests and the Rust
   tests consume the SAME files. A behavior change edits a fixture once and
   both suites enforce it.
2. **Shared integration suite.** `tests/integration.test.ts` gains a
   `PATROL_CLI` env override (default `bun src/cli.ts`): CI runs it twice —
   once per implementation — against the same real broker + seat-server.
   The Rust binary passes the identical suite or it doesn't ship.
3. **Broker API is the only interface.** The binary imports nothing from the
   TS tree; the frozen route map in `shared/types.ts` is duplicated as Rust
   types in one file (`src/api.rs`) with a comment pinning it to the TS
   source of truth.

## Layout

```
rust-cli/
  Cargo.toml
  src/main.rs        # clap dispatch
  src/api.rs         # broker types + client (route map mirror)
  src/compose.rs     # seat argv/env composition (golden-fixture-tested)
  src/commands/{up,down,status,send,list,doctor}.rs
```

Release: `cargo build --release` per target; GitHub Releases artifacts
(macOS arm64/x64, linux x64) + a brew tap when public. The Bun CLI remains
in-tree and canonical until the binary passes the shared suite on two
consecutive releases — then the binary becomes the documented entry point.

## Risks / kill criteria

- **Drift** between TS and Rust verbs. Mitigation is the parity contract;
  kill criterion: two drift bugs reach a user → delete one implementation
  (whichever has fewer users at that point) rather than maintain both.
- **`up` composition duplicated** (the subtlest logic: profiles, overlays,
  tmux lines). Mitigation: golden fixtures cover every branch of
  compose.ts before the port starts; the port is fixture-driven.
- **serde_yaml accepts more than the TS parser.** Benign direction, but
  document: configs authored against the binary may not parse in the Bun
  CLI. Acceptable — the binary is the end-state entry point.

## Go/no-go

Build when ALL hold:
1. v0.1 integration suite green over a week of real fleet use (not just CI),
2. at least one `patrol up` fleet used in anger for actual work,
3. the plugin/marketplace packaging question is settled (the binary's
   install story depends on it).

Estimate at go: ~1–2 days of gpt-5.5/opus implementation against the golden
fixtures, fable review at the end. Until then this spec is the whole
investment.
