/**
 * Shared secret for broker auth. Any local process could otherwise POST
 * /send-message and have its text land inside a Claude session framed as a
 * teammate message — a prompt-injection surface. The secret file gates that
 * to processes that can read the user's home directory.
 */
import { readFileSync, writeFileSync, lstatSync, chmodSync } from "node:fs";

const SECRET_PATH =
  process.env.CLAUDE_PATROL_SECRET_FILE ?? `${process.env.HOME}/.claude-patrol.secret`;

export const TOKEN_HEADER = "x-patrol-token";

// 0600 exactly: owner rw, no group/other bits (file-type bits in mode ignored)
export function secretPermsOk(mode: number): boolean {
  return (mode & 0o077) === 0 && (mode & 0o600) === 0o600;
}

// Guards a PREEXISTING secret file before it's trusted: never follows a symlink
// (a symlinked path could point anywhere the attacker controls), rejects a file
// owned by another uid, and self-repairs an over-permissive mode rather than
// silently trusting it. Throws (does not repair) on symlink or uid mismatch.
export function checkSecretPerms(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    throw new Error(`secret file ${path} is a symlink — refusing to follow it`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`secret file ${path} is owned by uid ${st.uid}, not the current user (${uid})`);
  }
  if (!secretPermsOk(st.mode)) {
    chmodSync(path, 0o600);
  }
}

// v0.3. Every seat backend does exactly this at the same moment — the third concrete use, so
// it lands here rather than being written out three times and drifting.
//
// The credential a seat presents after /register is its capability token, NOT the shared
// secret: the secret resolves to `full` scope, which is the operator's, and a seat holding it
// bypasses the entire per-seat boundary. Returning null means the broker minted none — a
// version skew, since token and enforcement ship together. That DEGRADES to the shared secret
// (the caller keeps its bootstrap credential) rather than refusing to run: a seat that hard-
// failed here would take the fleet down on a mixed-version install, which is a worse outcome
// than the pre-v0.3 trust model it falls back to. It is logged loudly because a silent
// degrade is precisely how the boundary came to be dead code in the first place.
export function adoptCapability(reg: { capability_token?: string }, log: (msg: string) => void): string | null {
  if (reg.capability_token) return reg.capability_token;
  log("WARNING: broker returned no capability_token — falling back to the shared secret. This seat runs at OPERATOR scope: the per-seat route allowlist and fleet boundary do NOT apply to it. Upgrade the broker.");
  return null;
}

export function getSecret(): string {
  let existing: string | null = null;
  try {
    checkSecretPerms(SECRET_PATH);
    existing = readFileSync(SECRET_PATH, "utf8").trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (existing !== null) {
    if (existing.length === 0) throw new Error(`secret file ${SECRET_PATH} is empty`);
    return existing;
  }
  const secret = crypto.randomUUID() + crypto.randomUUID();
  try {
    // wx: fail if another process created it between our check and write
    writeFileSync(SECRET_PATH, secret, { mode: 0o600, flag: "wx" });
    return secret;
  } catch {
    // lost the create race — another process made it; validate before trusting it
    checkSecretPerms(SECRET_PATH);
    const raced = readFileSync(SECRET_PATH, "utf8").trim();
    if (raced.length === 0) throw new Error(`secret file ${SECRET_PATH} is empty`);
    return raced;
  }
}
