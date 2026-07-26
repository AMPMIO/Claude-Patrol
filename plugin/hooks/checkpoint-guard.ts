#!/usr/bin/env bun
// PreToolUse: while `patrol checkpoint` holds a lease on this seat's worktree,
// DENY this seat's tool calls. Mutual exclusion, not detection — a fence that
// reads HEAD after `worktree remove` can't even see the tree it was meant to
// protect, so the seat is quiesced for the few seconds the merge takes instead
// (shared/types.ts, v0.2.9 lease block).
//
// WHAT THIS ACTUALLY BUYS — read before trusting it. A PreToolUse hook can stop
// the seat's TOOL CALLS and nothing else. It is NOT a guarantee that the seat's
// worktree is frozen:
//   * A background process the seat spawned BEFORE the lease landed (a watcher, a
//     `bun --watch`, a test runner started with run_in_background) keeps running and
//     keeps writing. No PreToolUse hook can see it, let alone stop it. Process-level
//     quiescence was considered and deliberately ruled OUT of scope for v0.2.9.1.
//   * A tool call already IN FLIGHT when the lease landed still completes — this hook
//     gates the NEXT call, not the running one. checkpoint's two-read settle window
//     (QUIESCE_SETTLE_MS) is what covers that one.
//   * Anything editing the tree from outside this seat entirely.
// checkpoint's FENCES 1/2/3 remain as the detector for what this cannot cover.
//
// v0.2.9.1 — the matcher this is installed under is now "*" (every tool), not the
// four built-in mutating tools. Enumerating write-capable tool names is the bypass
// class that earned the earlier deny-hook six proven escapes; a full-profile seat's
// MCP file-writing tools matched none of the four. See GUARD_MATCHER in src/profiles.ts.
//
// This therefore runs before EVERY tool call in every seat, so the fast path stays a
// single stat+read of the lease file the launcher named in LEASE_FILE_ENV — never an
// HTTP call to the broker, and never a parse of the tool's input schema.
//
// FAIL-OPEN on absolutely everything (no env, no file, expired, malformed,
// unreadable, unbound, any thrown error): a checkpoint killed between acquire and
// release must not wedge a seat forever, and a bug here would stop the whole fleet
// from working. A missed fence is recoverable; a wedged fleet is not.
//
// Self-contained on purpose (no cross-dir import, mirroring reg-session.ts) so it
// survives packaging — the env name below is LEASE_FILE_ENV in shared/types.ts and
// the token format is LEASE_TOKEN_RE.

import { readFileSync, writeSync } from "node:fs";

// A per-CHECKPOINT token minted by the broker, mirrored into the lease file. Matching
// the SHAPE here is a cheap structural check that the file came from a real acquire
// rather than being hand-rolled or truncated; the token's real job (refusing a second
// checkpoint, and refusing to release someone else's lease) is broker- and
// checkpoint-side, since a fail-open hook can never be the enforcement point.
const LEASE_TOKEN_RE = /^cpl-[0-9a-f]{32}$/;

// The lease-file format this hook understands (checkpoint.ts LEASE_FILE_VERSION). A file
// written by a NEWER checkpoint than this hook may have moved or redefined the fields
// below, so an unrecognized version FAILS OPEN rather than guessing — the same direction
// as every other unknown here. A wedged fleet is worse than a missed fence.
const SUPPORTED_LEASE_VERSION = 1;

// Is `child` the same directory as `parent`, or nested under it?
function within(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

// The session's cwd, as Claude Code reports it on stdin. process.cwd() is the fallback
// (Claude Code spawns hooks in the project dir) for the manual/plugin install path,
// where a caller may pass no stdin at all. Never throws — an unreadable stdin just
// means we fall back, and a bad cwd only ever costs us a deny (fail-open).
async function sessionCwd(): Promise<string> {
  try {
    const raw = await Bun.stdin.text();
    const cwd = JSON.parse(raw).cwd;
    if (typeof cwd === "string" && cwd.startsWith("/")) return cwd;
  } catch {
    /* no stdin, not JSON, no cwd -> fall back */
  }
  return process.cwd();
}

const leaseFile = process.env.CLAUDE_PATROL_LEASE_FILE;

if (leaseFile) {
  try {
    const lease = JSON.parse(readFileSync(leaseFile, "utf8"));

    // The string check on expires_at is load-bearing: Date.parse stringifies its
    // argument, so a numeric expires_at (12345) would parse as the year 12345 and
    // wedge the seat for ten millennia. Only the frozen ISO-string form can deny.
    const at = lease?.expires_at;
    const expires = typeof at === "string" ? Date.parse(at) : NaN;
    const live = Number.isFinite(expires) && expires > Date.now();

    // v0.2.9.1: the lease must name the WORKTREE it covers, and that worktree must
    // overlap this session. Lease files are per-seat-launch unique as of v0.2.9.1
    // (compose.ts leaseFile()), so a foreign file should never land on our path at
    // all — this is the second lock on that door: a leftover or hand-written file
    // naming somebody else's tree cannot freeze this seat.
    //
    // The containment test runs in BOTH directions because a seat's cwd may be the
    // worktree, a subdirectory of it, or (for a seat parked at the repo root) an
    // ancestor of it. Unrelated => allow.
    //
    // HONEST LIMIT: this is fail-open, so a seat whose cwd is genuinely disjoint from
    // its own leased worktree would NOT be denied. That case is closed on the other
    // side rather than here — `patrol checkpoint` refuses such a seat up front instead
    // of merging behind a guard that cannot bind (see checkpoint.ts, CWD BINDING).
    const path = lease?.path;
    const bound = typeof path === "string" && path.startsWith("/") && path.length > 1;

    const known = lease?.version === SUPPORTED_LEASE_VERSION;

    if (known && live && bound && typeof lease?.token === "string" && LEASE_TOKEN_RE.test(lease.token)) {
      const cwd = await sessionCwd();
      if (within(cwd, path) || within(path, cwd)) {
        // The matcher is "*", so this denies READS too and the seat is fully frozen for the
        // checkpoint's duration — which, behind a long gate, can be minutes rather than
        // seconds. So the reason has to be ACTIONABLE: give a wait, or the agent burns the
        // whole lease spinning through retries.
        //
        // This expiry is a FLOOR on the wait, never a deadline: checkpoint renews the lease
        // while it runs, so the pause can outlast the timestamp in the file. Saying "lifts
        // by <at>" would be a promise the renewal breaks, and an agent that believed it
        // would resume retrying mid-merge. Phrase it as "at least".
        const secondsLeft = Math.max(1, Math.ceil((expires - Date.now()) / 1000));
        writeSync(1, JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              `patrol checkpoint is merging this seat's worktree, so this seat is paused (reads included). ` +
              `Wait at least ~${secondsLeft}s (this lease runs to ${at} and is extended while the checkpoint runs), then retry. ` +
              `Do not work around this — the checkpoint is integrating the very tree you would be editing.`,
          },
        }));
      }
    }
  } catch {
    // absent / expired / malformed / unreadable -> allow
  }
}
process.exit(0);
