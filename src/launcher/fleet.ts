// Fleet identity: the ONE place a fleet name is validated, inferred, and turned
// into a tmux session name, a tmux target, or a state-file name.
//
// v0.3. The tmux session used to be the constant "patrol", so `patrol down` in
// ANY project killed EVERY project's seats — silent data loss the moment a
// second fleet exists. A fleet is now the isolation unit. Every consumer (up,
// down, cockpit, seat resolution) MUST derive its fleet through resolveFleet():
// a second inference path is a teardown that targets a session `up` never
// created, which is this bug again wearing a different hat.
//
// Nothing here does I/O — see fleet-detect.ts for the fs/yaml side.

import { basename } from "node:path";

// A fleet name becomes a tmux session-name segment, a state-file path segment,
// and a broker value joined into stable_key — the same three trust boundaries
// SEAT_NAME_RE guards for seat names, so it gets the same shape.
export const FLEET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// The fleet a config with no `fleet:` outside any repo lands on. Only reached
// when the directory basename slugs to nothing (e.g. "/" or "...").
export const DEFAULT_FLEET = "default";

// Every patrol tmux session is named `patrol-<fleet>`, with NO special case for
// a "default" fleet. Back-compat for `tmux attach -t patrol` comes from tmux's
// own target lookup, which falls back to a name PREFIX match: with one fleet
// running, `-t patrol` resolves to the sole `patrol-*` session (verified on tmux
// 3.6b); with two it refuses as ambiguous, which is exactly the answer a
// two-fleet machine should give a bare `patrol`. A grouped alias session
// (`new-session -t`) was the alternative and was rejected: killing one member of
// a tmux session group leaves the windows alive in the other member, so `patrol
// down` would have stopped nothing.
//
// Consequence for patrol's OWN calls: prefix matching is a footgun for us (a
// `-t patrol-app` would match `patrol-app2` if `patrol-app` were gone), so every
// internal target goes through exactSession/exactWindow below, which use tmux's
// `=` exact-match syntax.
export function sessionName(fleet: string): string {
  return `patrol-${fleet}`;
}

// tmux `=name` = match this session name EXACTLY; no prefix, no fnmatch.
export function exactSession(fleet: string): string {
  return `=${sessionName(fleet)}`;
}

export function exactWindow(fleet: string, window: string): string {
  return `${exactSession(fleet)}:${window}`;
}

// Inverse of sessionName, for enumerating live fleets out of `tmux list-sessions`.
// Returns null for any session patrol did not create.
export function fleetFromSession(session: string): string | null {
  if (!session.startsWith("patrol-")) return null;
  const fleet = session.slice("patrol-".length);
  return FLEET_NAME_RE.test(fleet) ? fleet : null;
}

// Per-fleet bg-seat record. One global fleet.json meant two fleets overwrote
// each other's records, so the second `patrol down` had nothing to stop.
export function fleetStateFileName(fleet: string): string {
  return `fleet-${fleet}.json`;
}

export function fleetFromStateFileName(name: string): string | null {
  const m = /^fleet-(.+)\.json$/.exec(name);
  if (!m) return null;
  return FLEET_NAME_RE.test(m[1]!) ? m[1]! : null;
}

// An EXPLICIT `fleet:` is the config author's word and a bad one is their
// mistake, so it throws rather than being silently repaired — a fleet that
// quietly became something else would tear down the wrong session.
export function validateFleetName(name: unknown): string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`\`fleet\` must be a non-empty string (got ${JSON.stringify(name)})`);
  }
  if (!FLEET_NAME_RE.test(name) || name === "." || name === "..") {
    throw new Error(
      `invalid fleet "${name}" — must match ${FLEET_NAME_RE} and not be "." or ".." (the name becomes a tmux session name, a state-file path segment, and part of each seat's stable_key)`
    );
  }
  return name;
}

// Turn an arbitrary directory basename into a legal fleet name. INFERENCE must
// never fail — a repo directory called "my project (old)" still has to launch —
// so illegal characters collapse here instead of throwing the way an explicit
// `fleet:` does. Deterministic: the same directory always yields the same fleet.
export function slugFleet(raw: string): string {
  const slug = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[^A-Za-z0-9]+$/, "")
    .slice(0, 64);
  return slug === "" ? DEFAULT_FLEET : slug;
}

export interface FleetOrigin {
  // patrol.yaml's top-level `fleet:`, when the config set one.
  explicit?: string | null;
  // git root of the config (null outside a repo).
  gitRoot?: string | null;
  // The config's directory (or the caller's cwd) — the fallback that makes
  // resolution deterministic outside a repo.
  dir: string;
}

// THE fleet-resolution function. Precedence: explicit `fleet:` > basename of the
// git root > basename of the config/cwd directory.
export function resolveFleet(origin: FleetOrigin): string {
  if (origin.explicit != null && origin.explicit !== "") {
    return validateFleetName(origin.explicit);
  }
  const root = origin.gitRoot != null && origin.gitRoot !== "" ? origin.gitRoot : origin.dir;
  return slugFleet(basename(root));
}

// --- teardown selection (pure) ----------------------------------------------

export interface DownRequest {
  // A fleet named on the command line: `patrol down other-project`.
  explicit: string | null;
  all: boolean;
}

// Which fleets `patrol down` may touch. `known` is the union of live tmux
// sessions and on-disk fleet-state files.
//
// The refusal is the whole point of v0.3: with no explicit target, down operates
// on the CALLER's fleet only, and if the caller's fleet is not running while
// other fleets are, it stops and names them instead of falling back to killing
// whatever it can find (which is how the old global session killed a neighbour's
// seats mid-task).
export function selectFleetsToDown(
  req: DownRequest,
  callerFleet: string,
  known: string[]
): { fleets: string[] } | { error: string } {
  if (req.all && req.explicit != null) {
    return { error: `patrol down: --all and an explicit fleet ("${req.explicit}") are contradictory — pick one` };
  }
  if (req.all) {
    return { fleets: [...new Set(known)].sort() };
  }
  if (req.explicit != null) {
    try {
      return { fleets: [validateFleetName(req.explicit)] };
    } catch (e) {
      return { error: `patrol down: ${(e as Error).message}` };
    }
  }
  if (known.includes(callerFleet) || known.length === 0) {
    return { fleets: [callerFleet] };
  }
  return {
    error:
      `patrol down: no fleet "${callerFleet}" here, and refusing to tear down someone else's — ` +
      `running: ${[...new Set(known)].sort().join(", ")}. Name one (\`patrol down <fleet>\`) or use --all.`,
  };
}
