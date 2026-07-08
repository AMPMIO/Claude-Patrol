/**
 * Shared secret for broker auth. Any local process could otherwise POST
 * /send-message and have its text land inside a Claude session framed as a
 * teammate message — a prompt-injection surface. The secret file gates that
 * to processes that can read the user's home directory.
 */
import { readFileSync, writeFileSync } from "node:fs";

const SECRET_PATH =
  process.env.CLAUDE_PATROL_SECRET_FILE ?? `${process.env.HOME}/.claude-patrol.secret`;

export const TOKEN_HEADER = "x-patrol-token";

export function getSecret(): string {
  try {
    return readFileSync(SECRET_PATH, "utf8").trim();
  } catch {
    const secret = crypto.randomUUID() + crypto.randomUUID();
    try {
      // wx: fail if another process created it between our read and write
      writeFileSync(SECRET_PATH, secret, { mode: 0o600, flag: "wx" });
      return secret;
    } catch {
      return readFileSync(SECRET_PATH, "utf8").trim();
    }
  }
}
