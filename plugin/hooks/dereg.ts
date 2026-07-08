#!/usr/bin/env bun
// SessionEnd: deregister this seat from the broker via the frozen /unregister
// route (UnregisterRequest {id?, pid?}). The hook's parent process ($PPID) IS
// the registered Claude session pid, so we unregister by pid — no seat-id env
// needed. Best-effort: the broker's stale-PID sweep is the real guarantee, so
// any failure here (broker down, timeout) is ignored.
// Self-contained on purpose (no cross-dir import) so it survives packaging.

const port = process.env.CLAUDE_PATROL_PORT || "7900";
const secretFile = process.env.CLAUDE_PATROL_SECRET_FILE || `${process.env.HOME}/.claude-patrol.secret`;

try {
  const token = (await Bun.file(secretFile).text()).trim();
  await fetch(`http://127.0.0.1:${port}/unregister`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-patrol-token": token },
    body: JSON.stringify({ pid: process.ppid }),
    signal: AbortSignal.timeout(1000),
  });
} catch {
  // best-effort; broker stale-PID sweep covers correctness
}
process.exit(0);
