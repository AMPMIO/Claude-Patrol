#!/usr/bin/env bun
// SessionStart: report this session's identity to the broker via the frozen
// /observe-session route (ObserveSessionRequest) so MANUAL seats — sessions
// not launched by `patrol up` — get exact cost attribution (Layer 2) instead
// of the window heuristic. CC hands session_id + transcript_path on stdin
// (documented common hook input fields); the hook's parent ($PPID) IS the
// claude process the seat-server registers. Best-effort: a dead broker must
// never break session startup, so every failure path exits 0.
// Self-contained on purpose (no cross-dir import) so it survives packaging.

const port = process.env.CLAUDE_PATROL_PORT || "7900";
const secretFile = process.env.CLAUDE_PATROL_SECRET_FILE || `${process.env.HOME}/.claude-patrol.secret`;

try {
  const input = JSON.parse(await Bun.stdin.text());
  const session_id = input.session_id;
  const transcript_path = input.transcript_path;
  if (typeof session_id === "string" && session_id && typeof transcript_path === "string" && transcript_path) {
    const token = (await Bun.file(secretFile).text()).trim();
    await fetch(`http://127.0.0.1:${port}/observe-session`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-patrol-token": token },
      body: JSON.stringify({
        session_id,
        transcript_path,
        cwd: process.cwd(),
        claude_pid: process.ppid,
      }),
      signal: AbortSignal.timeout(2000),
    });
  }
} catch {
  // best-effort; Layer 1 (launch marker) and Layer 3 (heuristic) still stand
}
process.exit(0);
