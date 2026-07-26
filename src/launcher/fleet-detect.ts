// The I/O half of fleet identity: find the patrol.yaml that governs a directory,
// find its git root, and hand both to the pure resolveFleet().
//
// Split from fleet.ts so the resolution rule stays unit-testable without a
// filesystem, and so fleet.ts (imported by yaml.ts) never imports yaml.ts back.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parsePatrolConfig } from "./yaml.ts";
import { resolveFleet } from "./fleet.ts";

// nearest ancestor holding a .git entry (dir OR file — worktrees use a file).
// Duplicated from commands/_client.ts rather than imported: the launcher must
// not depend on the CLI client module, and this is four lines.
export function gitRootOf(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The fleet a given patrol.yaml launches. `explicit` is passed in (not re-parsed)
// because `patrol up` has already parsed and validated the config.
export function fleetForConfig(configPath: string, explicit: string | null | undefined): string {
  const dir = dirname(configPath);
  return resolveFleet({ explicit: explicit ?? null, gitRoot: gitRootOf(dir), dir });
}

// The fleet a bare `patrol <cmd>` belongs to, inferred from cwd.
//
// An explicit `fleet:` must win here exactly as it does in `patrol up`, or
// `down` and `send` would target `patrol-<git-basename>` while `up` created
// `patrol-<explicit>`. So this looks for the governing patrol.yaml — cwd first,
// then the git root — and reads its `fleet:`. A config that fails to parse is
// ignored rather than fatal: an unrelated broken yaml must not make `patrol
// list` unusable.
export function detectFleet(cwd: string = process.cwd()): string {
  const root = gitRootOf(cwd);
  let explicit: string | null = null;
  // Outside a repo the fallback is a DIRECTORY basename, so it must be the
  // config's directory — the same one `patrol up` used — not the caller's cwd.
  let dir = cwd;
  for (const candidateDir of root && root !== cwd ? [cwd, root] : [cwd]) {
    const candidate = join(candidateDir, "patrol.yaml");
    if (!existsSync(candidate)) continue;
    dir = candidateDir;
    try {
      explicit = parsePatrolConfig(readFileSync(candidate, "utf8")).fleet ?? null;
    } catch {
      explicit = null;
    }
    break;
  }
  return resolveFleet({ explicit, gitRoot: root, dir });
}
