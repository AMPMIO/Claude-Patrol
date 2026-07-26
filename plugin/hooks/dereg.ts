#!/usr/bin/env bun
// SessionEnd: deregister this seat from the broker via the frozen /unregister
// route (UnregisterRequest {id?, pid?}). Contract: $PPID here IS the claude
// process, and the seat-server registers that SAME pid (v0.2 switched seat
// registration from the server's own pid to the claude pid so this join works),
// so we unregister by pid — no seat-id env needed. Best-effort: the broker's
// stale-PID sweep is the real guarantee, so any failure here (broker down,
// timeout) is ignored.
// Self-contained on purpose (no cross-dir import) so it survives packaging.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const port = process.env.CLAUDE_PATROL_PORT || "7900";
const secretFile = process.env.CLAUDE_PATROL_SECRET_FILE || `${process.env.HOME}/.claude-patrol.secret`;

// v0.3.1: present this seat's OWN capability when it has one. /unregister is a seat-owned
// route and the broker resolves our $PPID to exactly the seat row this token belongs to, so
// the call fits inside seat scope — the operator secret is only needed when there is no seat
// credential yet (a SessionStart-adjacent end, or a session the launcher never fleeted).
//
// The derivation is a hand copy of credFilePath() in shared/auth.ts, forced by the
// self-contained rule above. tests/wiring.test.ts asserts the two still agree, so a drift here
// cannot silently send every SessionEnd back to the operator secret.
function credFile(): string | null {
  const explicit = process.env.CLAUDE_PATROL_CRED_FILE;
  if (explicit && explicit.length > 0) return explicit;
  const key = process.env.CLAUDE_PATROL_STABLE_KEY;
  if (!key || key.length === 0) return null;
  const slug = key.replace(/[^A-Za-z0-9._-]/g, "-");
  const suffix = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return join(homedir(), ".claude-patrol", "creds", `${slug}-${suffix}.token`);
}

async function readAuth(): Promise<string> {
  const cred = credFile();
  if (cred) {
    try {
      const t = JSON.parse(await Bun.file(cred).text()).token;
      if (typeof t === "string" && t.length > 0) return t;
    } catch {
      // no seat credential (never registered, or already torn down) — fall back below
    }
  }
  return (await Bun.file(secretFile).text()).trim();
}

try {
  const token = await readAuth();
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
