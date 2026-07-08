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
