#!/usr/bin/env bun
// PreToolUse: while `patrol checkpoint` holds a lease on this seat's worktree,
// DENY the mutating tools this hook is matched against. Mutual exclusion, not
// detection — a fence that reads HEAD after `worktree remove` can't even see the
// tree it was meant to protect, so the seat is quiesced for the few seconds the
// merge takes instead (shared/types.ts, v0.2.9 lease block).
//
// This runs before EVERY matched tool call in every seat, so the fast path is a
// single stat+read of the lease file the launcher named in LEASE_FILE_ENV — never
// an HTTP call to the broker, and never a parse of the tool's input schema.
//
// FAIL-OPEN on absolutely everything (no env, no file, expired, malformed,
// unreadable, any thrown error): a checkpoint killed between acquire and release
// must not wedge a seat forever, and a bug here would stop the whole fleet from
// working. A missed fence is recoverable; a wedged fleet is not.
//
// Self-contained on purpose (no cross-dir import, mirroring reg-session.ts) so it
// survives packaging — the env name below is LEASE_FILE_ENV in shared/types.ts.

import { readFileSync, writeSync } from "node:fs";

const leaseFile = process.env.CLAUDE_PATROL_LEASE_FILE;

if (leaseFile) {
  try {
    // The string check is load-bearing: Date.parse stringifies its argument, so a
    // numeric expires_at (12345) would parse as the year 12345 and wedge the seat
    // for ten millennia. Only the frozen ISO-string form can deny.
    const at = JSON.parse(readFileSync(leaseFile, "utf8")).expires_at;
    const expires = typeof at === "string" ? Date.parse(at) : NaN;
    if (Number.isFinite(expires) && expires > Date.now()) {
      // writeSync(1) not process.stdout.write: process.exit can drop a buffered
      // async write, and a dropped deny is a silently unguarded seat.
      writeSync(1, JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "patrol checkpoint in progress on this seat's worktree — hands off for a few seconds, then retry",
        },
      }));
    }
  } catch {
    // absent / expired / malformed / unreadable -> allow
  }
}
process.exit(0);
