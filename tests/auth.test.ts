import { test, expect } from "bun:test";
import { mkdtempSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// shared/auth.ts reads CLAUDE_PATROL_SECRET_FILE once at module load (SECRET_PATH
// is a module-level const), so each test gets its own temp dir + a cache-busted
// dynamic import (Bun treats a distinct query string as a distinct module
// instance) to force a fresh read of the env var it sets.
let n = 0;
async function freshAuth(secretFile: string) {
  process.env.CLAUDE_PATROL_SECRET_FILE = secretFile;
  return import(`../shared/auth.ts?auth-test=${n++}`);
}

function tempSecretPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "patrol-auth-test-"));
  return join(dir, ".claude-patrol.secret");
}

test("fresh create: 0600 and readable", async () => {
  const path = tempSecretPath();
  const { getSecret } = await freshAuth(path);
  const secret = getSecret();
  expect(secret.length).toBeGreaterThan(0);
  const st = statSync(path);
  expect(st.mode & 0o777).toBe(0o600);
});

test("preexisting 0644 file self-repairs to 0600 and returns its secret", async () => {
  const path = tempSecretPath();
  writeFileSync(path, "preexisting-secret", { mode: 0o644 });
  const { getSecret } = await freshAuth(path);
  const secret = getSecret();
  expect(secret).toBe("preexisting-secret");
  const st = statSync(path);
  expect(st.mode & 0o777).toBe(0o600);
});

test("symlinked secret throws", async () => {
  const path = tempSecretPath();
  const targetPath = tempSecretPath();
  writeFileSync(targetPath, "real-secret", { mode: 0o600 });
  symlinkSync(targetPath, path);
  const { getSecret } = await freshAuth(path);
  expect(() => getSecret()).toThrow(/symlink/);
});

test("empty file throws", async () => {
  const path = tempSecretPath();
  writeFileSync(path, "   \n", { mode: 0o600 });
  const { getSecret } = await freshAuth(path);
  expect(() => getSecret()).toThrow(/empty/);
});

test("second getSecret() call is idempotent", async () => {
  const path = tempSecretPath();
  const { getSecret } = await freshAuth(path);
  const first = getSecret();
  const second = getSecret();
  expect(second).toBe(first);
});

test("checkSecretPerms throws on symlink without touching getSecret", async () => {
  const path = tempSecretPath();
  const targetPath = tempSecretPath();
  writeFileSync(targetPath, "real-secret", { mode: 0o600 });
  symlinkSync(targetPath, path);
  const { checkSecretPerms } = await freshAuth(tempSecretPath());
  expect(() => checkSecretPerms(path)).toThrow(/symlink/);
});

test("secretPermsOk accepts 0600 only", async () => {
  const { secretPermsOk } = await freshAuth(tempSecretPath());
  expect(secretPermsOk(0o600)).toBe(true);
  expect(secretPermsOk(0o100600)).toBe(true); // regular-file type bits ignored
  expect(secretPermsOk(0o644)).toBe(false);
  expect(secretPermsOk(0o660)).toBe(false);
});

test("checkSecretPerms self-repairs an over-permissive mode in place", async () => {
  const path = tempSecretPath();
  writeFileSync(path, "x", { mode: 0o644 });
  const { checkSecretPerms } = await freshAuth(tempSecretPath());
  checkSecretPerms(path);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});
