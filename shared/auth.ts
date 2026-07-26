/**
 * Shared secret for broker auth. Any local process could otherwise POST
 * /send-message and have its text land inside a Claude session framed as a
 * teammate message — a prompt-injection surface. The secret file gates that
 * to processes that can read the user's home directory.
 */
import { readFileSync, writeFileSync, lstatSync, chmodSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

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
// bypasses the entire per-seat boundary. No token means the broker minted none — a version
// skew, since token and enforcement ship together.
//
// v0.3.1: this THROWS rather than degrading. It used to keep the bootstrap secret and log a
// warning, on the theory that a hard failure would take a fleet down on a mixed-version
// install. That reasoning was wrong in this project: the broker is a supervised daemon that
// auto-restarts on current code, so the "mixed version" state is one `patrol down` from being
// fixed, whereas the degrade silently ran EVERY seat at operator scope — which is how the
// boundary came to be dead code in the first place. A log line is not a control.
export function adoptCapability(reg: { capability_token?: string }): string {
  if (reg.capability_token) return reg.capability_token;
  const port = process.env.CLAUDE_PATROL_PORT || "7900";
  throw new Error(
    "broker returned no capability_token — refusing to run at OPERATOR scope.\n" +
      "  This broker predates v0.3 capability tokens (token and enforcement ship together).\n" +
      `  Fix: stop it and it restarts on current code — \`patrol down\`, or kill the daemon on 127.0.0.1:${port}.\n` +
      "  Then relaunch this seat."
  );
}

// --- v0.3.1 per-seat CLI credential ---------------------------------------------------------
//
// The seat-server's own MCP instructions tell a seat to run `patrol send/list/status` through
// Bash, and the CLI authenticated with the machine-wide operator secret — so the normal seat
// action arrived at the broker as `full` scope and the per-seat allowlist and fleet
// confinement never ran. The fix is for the CLI to find the CALLER'S OWN capability when the
// caller is a seat. That credential is not a leak: it is exactly the seat's own authority.
// The OPERATOR secret is the thing that must never be handed to a seat, and it still is not.
//
// This does NOT contain a compromised seat — a seat with shell access reads the operator
// secret file directly, same uid, mode 0600. See the README caveat.
export const CRED_FILE_ENV = "CLAUDE_PATROL_CRED_FILE";

// The launcher's stable-key variable (compose.ts STABLE_KEY_ENV). Duplicated as a literal
// rather than imported: shared/auth.ts is on the BROKER's import graph and must not drag in
// src/launcher. tests/wiring.test.ts asserts the two spellings still agree.
const STABLE_KEY_ENV = "CLAUDE_PATROL_STABLE_KEY";

// Where ONE seat's capability token lives. Derived from the stable key (fleet + seat name)
// because that is the only per-seat identifier present in BOTH the seat process and the Bash
// environment the seat's `patrol` runs in — the seat-server is a child of `claude` and cannot
// export anything back into its parent's environment. CRED_FILE_ENV overrides it for tests and
// for any launcher that wants to name the path explicitly.
//
// The 8-hex suffix is not decoration: the readable slug maps `a/b-c` and `a-b/c` to the same
// name, and a collision there means two live seats sharing one credential file — i.e. a seat's
// CLI authenticating as a DIFFERENT seat. The hash makes that unreachable while keeping the
// filename greppable by a human.
export function credFilePath(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env[CRED_FILE_ENV];
  if (explicit && explicit.length > 0) return explicit;
  const key = env[STABLE_KEY_ENV];
  if (!key || key.length === 0) return null;
  const slug = key.replace(/[^A-Za-z0-9._-]/g, "-");
  const suffix = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return join(homedir(), ".claude-patrol", "creds", `${slug}-${suffix}.token`);
}

// The file carries the seat ID as well as the token, and it has to: `patrol send` posts a
// `from_id`, which the broker treats as an IDENTITY ASSERTION and checks against the token's
// seat. Hardcoded `from_id: "cli"` (the operator) fails that check — so without the id here a
// seat's own `patrol send` would 403, i.e. the fix would break the exact command seats are
// instructed to use. It also removes a smaller misfeature the reviews did not name: a seat's
// message used to be attributed to "cli", so a seat could make its text render as the
// operator's. Now it renders as the seat, because the broker verified it IS the seat.
export interface SeatCredential {
  seat_id: string;
  token: string;
}

// Atomic + 0600. Atomic because the CLI reads this path concurrently with a seat relaunch
// rewriting it, and a torn read is an unauthenticated request. The explicit chmod is because
// writeFileSync's mode is masked by umask, and a group-readable capability token would hand
// the seat's authority to anything else running as a member of that group.
export function writeCredFile(path: string, cred: SeatCredential): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cred), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// Parse, with the shape actually enforced. A truncated or hand-edited file yields null and the
// caller falls back to the operator secret — the same treatment as an absent file, because in
// both cases nothing was presented to the broker.
export function parseCredFile(raw: string): SeatCredential | null {
  try {
    const v = JSON.parse(raw) as Partial<SeatCredential>;
    if (typeof v.seat_id !== "string" || typeof v.token !== "string") return null;
    if (v.seat_id.length === 0 || v.token.length === 0) return null;
    return { seat_id: v.seat_id, token: v.token };
  } catch {
    return null;
  }
}

// Teardown. Best-effort by design: the broker revokes the token with the seat, so a file that
// outlives a crash is a dead credential, not a live one.
export function removeCredFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
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
