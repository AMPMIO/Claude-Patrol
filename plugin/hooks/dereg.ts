#!/usr/bin/env bun
// SessionEnd: best-effort deregister this seat from the broker.
//
// Correctness does NOT depend on this — the broker purges dead-PID seats on
// its next sweep (CONTRACTS.md: stale-PID cleanup). This only makes teardown
// immediate when the seat id is known.
//
// W3 -> orchestrator escalation: a deterministic dereg needs two additions to
// the FROZEN contract (shared/types.ts), which W3 must not edit:
//   1. a `/dereg` route + `DeregRequest { id }`
//   2. the seat's id exposed to hooks as `CLAUDE_PATROL_SEAT_ID`
// Until both land this no-ops safely (no id, or the route 404s -> ignored).
// Self-contained on purpose: no cross-dir import, so it survives packaging.

const id = process.env.CLAUDE_PATROL_SEAT_ID;
if (!id) process.exit(0);

const port = process.env.CLAUDE_PATROL_PORT || "7900";
const secretFile = process.env.CLAUDE_PATROL_SECRET_FILE || `${process.env.HOME}/.claude-patrol.secret`;

try {
  const token = (await Bun.file(secretFile).text()).trim();
  await fetch(`http://127.0.0.1:${port}/dereg`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-patrol-token": token },
    body: JSON.stringify({ id }),
    signal: AbortSignal.timeout(1000),
  });
} catch {
  // best-effort; broker stale-PID sweep is the real guarantee
}
process.exit(0);
