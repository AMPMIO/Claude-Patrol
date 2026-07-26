import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_FLEET, FLEET_NAME_RE, exactSession, exactWindow, fleetFromSession, fleetFromStateFileName,
  fleetStateFileName, resolveFleet, selectFleetsToDown, sessionName, slugFleet, validateFleetName,
} from "../src/launcher/fleet.ts";
import { detectFleet, fleetForConfig, gitRootOf } from "../src/launcher/fleet-detect.ts";
import { parsePatrolConfig } from "../src/launcher/yaml.ts";
import { composeSeat, planSeat, stableKey, FLEET_ENV, STABLE_KEY_ENV } from "../src/launcher/compose.ts";
import { parseSeatTarget, filterByFleet, resolveSeatIn, BrokerError } from "../src/commands/_client.ts";
import type { SeatSpec } from "../shared/types.ts";

// v0.3 multi-fleet isolation. The bug this closes: TMUX_SESSION was the constant
// "patrol", so `patrol down` in any project killed every project's seats.

// --- fleet resolution -------------------------------------------------------

describe("resolveFleet precedence", () => {
  test("explicit `fleet:` wins over the git root", () => {
    expect(resolveFleet({ explicit: "acme", gitRoot: "/src/other-repo", dir: "/src/other-repo/cfg" })).toBe("acme");
  });
  test("no explicit -> git-root basename, not the config dir", () => {
    expect(resolveFleet({ gitRoot: "/src/my-repo", dir: "/src/my-repo/deep/cfg" })).toBe("my-repo");
  });
  test("outside a repo -> config-dir basename, deterministically", () => {
    expect(resolveFleet({ gitRoot: null, dir: "/tmp/scratch-fleet" })).toBe("scratch-fleet");
    expect(resolveFleet({ gitRoot: null, dir: "/tmp/scratch-fleet" })).toBe("scratch-fleet");
  });
  test("an INFERRED name is slugged, never rejected — a repo dir can be anything", () => {
    expect(resolveFleet({ gitRoot: "/src/my project (old)", dir: "/x" })).toBe("my-project-old");
    expect(resolveFleet({ gitRoot: "/", dir: "/" })).toBe(DEFAULT_FLEET);
  });
  test("an EXPLICIT bad name throws — it is the author's word, not ours to repair", () => {
    expect(() => resolveFleet({ explicit: "../evil", dir: "/x" })).toThrow(/invalid fleet/);
  });
});

describe("fleet name validation (injection shapes)", () => {
  for (const bad of ["../evil", "a/b", "a b", ".", "..", "-lead", "a;rm -rf /", "$(whoami)", "=patrol", "", "x".repeat(65)]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => validateFleetName(bad)).toThrow();
      // and the same value never survives a config parse
      expect(() => parsePatrolConfig(`fleet: ${JSON.stringify(bad)}\nseats:\n  - name: a\n    model: opus\n`)).toThrow(/patrol\.yaml/);
    });
  }
  test("accepts ordinary project names", () => {
    for (const ok of ["acme", "my-repo", "Claude-Patrol", "v0.3", "a_b", "x"]) {
      expect(validateFleetName(ok)).toBe(ok);
      expect(FLEET_NAME_RE.test(ok)).toBe(true);
    }
  });
  test("slugFleet never produces a name validate would reject", () => {
    for (const raw of ["my project (old)", "@scope/pkg", "---", "  ", "..", "ünïcode-dir", "/"]) {
      expect(() => validateFleetName(slugFleet(raw))).not.toThrow();
    }
  });
});

describe("parsePatrolConfig fleet", () => {
  const seats = "seats:\n  - name: a\n    model: opus\n";
  test("absent -> undefined (an existing patrol.yaml is unchanged)", () => {
    expect(parsePatrolConfig(seats).fleet).toBeUndefined();
  });
  test("present -> carried through", () => {
    expect(parsePatrolConfig(`fleet: acme\n${seats}`).fleet).toBe("acme");
  });
  test("non-string is a config error, not a coerced name", () => {
    expect(() => parsePatrolConfig(`fleet: 12\n${seats}`)).toThrow(/must be a non-empty string/);
  });
});

// --- session naming + back-compat -------------------------------------------

describe("session naming", () => {
  test("always patrol-<fleet>; targets are `=`-exact", () => {
    expect(sessionName("acme")).toBe("patrol-acme");
    expect(exactSession("acme")).toBe("=patrol-acme");
    expect(exactWindow("acme", "builder")).toBe("=patrol-acme:builder");
  });
  test("BACK-COMPAT: `tmux attach -t patrol` prefix-matches the sole patrol-* session", () => {
    // tmux resolves -t by exact name, then by PREFIX (verified on tmux 3.6b), so a
    // bare `patrol` reaches the only fleet on a single-fleet machine and is
    // ambiguous — correctly — once a second exists. This assertion pins the
    // property that makes that work: every session name starts with "patrol".
    for (const f of ["acme", "default", "my-repo"]) {
      expect(sessionName(f).startsWith("patrol")).toBe(true);
    }
    // …and patrol's OWN calls opt out of prefix matching, so `patrol-app` can
    // never be aimed at a live `patrol-app2`.
    expect(exactSession("app")).not.toBe(sessionName("app"));
    expect(exactSession("app")[0]).toBe("=");
  });
  test("fleetFromSession inverts it and ignores foreign sessions", () => {
    expect(fleetFromSession("patrol-acme")).toBe("acme");
    expect(fleetFromSession("work")).toBeNull();
    expect(fleetFromSession("patrol-")).toBeNull();
    expect(fleetFromSession("patrol-../evil")).toBeNull();
  });
  test("state file is per fleet and round-trips", () => {
    expect(fleetStateFileName("acme")).toBe("fleet-acme.json");
    expect(fleetFromStateFileName("fleet-acme.json")).toBe("acme");
    expect(fleetFromStateFileName("fleet.json")).toBeNull(); // the old global file is not a fleet
    expect(fleetFromStateFileName("notes.json")).toBeNull();
  });
});

// --- THE regression: teardown is fleet-scoped -------------------------------

describe("selectFleetsToDown", () => {
  test("two fleets running, bare `down` touches ONLY the caller's", () => {
    const r = selectFleetsToDown({ explicit: null, all: false }, "alpha", ["alpha", "beta"]);
    expect(r).toEqual({ fleets: ["alpha"] });
    // beta is never named -> its session is never killed
    expect("fleets" in r && r.fleets.includes("beta")).toBe(false);
  });
  test("caller's fleet is not running but someone else's is -> REFUSE, kill nothing", () => {
    const r = selectFleetsToDown({ explicit: null, all: false }, "alpha", ["beta", "gamma"]);
    expect("error" in r).toBe(true);
    expect("error" in r && r.error).toMatch(/refusing to tear down someone else's/);
    expect("error" in r && r.error).toMatch(/beta, gamma/);
  });
  test("nothing running -> the caller's own fleet, which is a clean no-op", () => {
    expect(selectFleetsToDown({ explicit: null, all: false }, "alpha", [])).toEqual({ fleets: ["alpha"] });
  });
  test("crossing fleets requires naming one", () => {
    expect(selectFleetsToDown({ explicit: "beta", all: false }, "alpha", ["alpha", "beta"])).toEqual({ fleets: ["beta"] });
  });
  test("--all is the ONLY way to reach every fleet", () => {
    expect(selectFleetsToDown({ explicit: null, all: true }, "alpha", ["beta", "alpha"])).toEqual({ fleets: ["alpha", "beta"] });
  });
  test("--all plus a name is contradictory, not a silent winner", () => {
    const r = selectFleetsToDown({ explicit: "beta", all: true }, "alpha", ["alpha", "beta"]);
    expect("error" in r && r.error).toMatch(/contradictory/);
  });
  test("an injection-shaped explicit name is refused before any tmux call", () => {
    const r = selectFleetsToDown({ explicit: "../../evil", all: false }, "alpha", ["alpha"]);
    expect("error" in r && r.error).toMatch(/invalid fleet/);
  });
});

// --- inference on a real filesystem -----------------------------------------

describe("detectFleet / fleetForConfig agree", () => {
  const root = mkdtempSync(join(tmpdir(), "patrol-fleet-"));

  test("a repo with no `fleet:` -> git-root basename, from cwd OR from the config", () => {
    const repo = join(root, "widget-shop");
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, ".git"), "gitdir: /elsewhere\n"); // worktree-style .git FILE
    const cfg = join(repo, "patrol.yaml");
    writeFileSync(cfg, "seats:\n  - name: a\n    model: opus\n");
    expect(gitRootOf(join(repo, "sub"))).toBe(repo);
    expect(detectFleet(repo)).toBe("widget-shop");
    expect(detectFleet(join(repo, "sub"))).toBe("widget-shop");
    expect(fleetForConfig(cfg, parsePatrolConfig(readFileSync(cfg, "utf8")).fleet)).toBe("widget-shop");
  });

  test("an explicit `fleet:` wins for BOTH — down must not target a session up never made", () => {
    const repo = join(root, "widget-shop-2");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, ".git"), "gitdir: /elsewhere\n");
    const cfg = join(repo, "patrol.yaml");
    writeFileSync(cfg, "fleet: acme\nseats:\n  - name: a\n    model: opus\n");
    expect(fleetForConfig(cfg, "acme")).toBe("acme");
    expect(detectFleet(repo)).toBe("acme");
  });

  test("outside a repo, a config dir still resolves deterministically", () => {
    const dir = join(root, "loose-fleet");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "patrol.yaml"), "seats:\n  - name: a\n    model: opus\n");
    expect(gitRootOf(dir)).toBeNull();
    expect(detectFleet(dir)).toBe("loose-fleet");
    expect(fleetForConfig(join(dir, "patrol.yaml"), null)).toBe("loose-fleet");
  });

  test("a patrol.yaml that fails to parse degrades to inference, never throws", () => {
    const dir = join(root, "broken-fleet");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "patrol.yaml"), "this is: [not, a, seats, list\n");
    expect(detectFleet(dir)).toBe("broken-fleet");
  });
});

// --- fleet identity reaches the seat ----------------------------------------

describe("composeSeat carries fleet + stable_key", () => {
  const paths = { settingsFile: null, mcpConfigFile: "/prof/x.mcp.json", leaseFile: null };
  const compose = (spec: SeatSpec, fleet: string | null) =>
    composeSeat(planSeat(spec, {}, "/work"), paths, null, null, fleet).env;

  test("stable_key is fleet + seat name — unchanged by a relaunch", () => {
    expect(stableKey("acme", "builder")).toBe("acme/builder");
  });

  test("a tmux seat gets both", () => {
    const env = compose({ name: "builder", model: "opus" }, "acme");
    expect(env[FLEET_ENV]).toBe("acme");
    expect(env[STABLE_KEY_ENV]).toBe("acme/builder");
  });

  test("adapter seats (codex, headless) get them too — a fleet is not a Claude concept", () => {
    for (const backend of ["codex", "headless"] as const) {
      const env = compose({ name: "builder", model: "gpt-5.5", backend }, "acme");
      expect(env[FLEET_ENV]).toBe("acme");
      expect(env[STABLE_KEY_ENV]).toBe("acme/builder");
    }
  });

  test("two fleets' same-named seats get DIFFERENT stable keys", () => {
    expect(compose({ name: "builder", model: "opus" }, "alpha")[STABLE_KEY_ENV])
      .not.toBe(compose({ name: "builder", model: "opus" }, "beta")[STABLE_KEY_ENV]);
  });

  test("no fleet -> neither var is set (rather than an empty-string fleet)", () => {
    const env = compose({ name: "builder", model: "opus" }, null);
    expect(env[FLEET_ENV]).toBeUndefined();
    expect(env[STABLE_KEY_ENV]).toBeUndefined();
  });
});

// --- fleet-scoped seat resolution -------------------------------------------

describe("resolveSeatIn", () => {
  const seats = [
    { id: "aaaa1111", handle: "builder", role: "builder", fleet: "alpha" },
    { id: "bbbb2222", handle: "builder", role: "builder", fleet: "beta" },
    { id: "cccc3333", handle: "scout", role: "scout", fleet: "beta" },
    { id: "dddd4444", handle: "legacy", role: null }, // pre-0.3: no fleet reported
  ];

  test("bare handle resolves within the CALLER's fleet", () => {
    expect(resolveSeatIn(seats, "builder", "alpha")).toBe("aaaa1111");
    expect(resolveSeatIn(seats, "builder", "beta")).toBe("bbbb2222");
  });
  test("`fleet/handle` reaches across explicitly", () => {
    expect(resolveSeatIn(seats, "beta/builder", "alpha")).toBe("bbbb2222");
    expect(resolveSeatIn(seats, "alpha/builder", "beta")).toBe("aaaa1111");
  });
  test("another fleet's seat is NOT reachable bare — it is not silently picked", () => {
    expect(() => resolveSeatIn(seats, "scout", "alpha")).toThrow(BrokerError);
    expect(() => resolveSeatIn(seats, "scout", "alpha")).toThrow(/<fleet>\/scout/);
  });
  test("ambiguity inside one fleet still errors with candidates", () => {
    const twins = [
      { id: "aaaa1111", handle: "builder", role: "lead", fleet: "alpha" },
      { id: "aaaa2222", handle: "builder", role: "twin", fleet: "alpha" },
    ];
    expect(() => resolveSeatIn(twins, "builder", "alpha")).toThrow(/ambiguous handle/);
    expect(() => resolveSeatIn(twins, "aaaa", "alpha")).toThrow(/ambiguous id prefix/);
    // The SAME two handles split across fleets are not ambiguous at all.
    expect(resolveSeatIn(seats, "builder", "alpha")).toBe("aaaa1111");
  });
  test("id and unique id-prefix still work, scoped", () => {
    expect(resolveSeatIn(seats, "cccc3333", "beta")).toBe("cccc3333");
    expect(resolveSeatIn(seats, "cccc", "beta")).toBe("cccc3333");
    // …and an id from another fleet is out of scope, not a wrong-fleet hit.
    expect(() => resolveSeatIn(seats, "cccc3333", "alpha")).toThrow(/no live seat matches/);
  });
  test("a seat reporting no fleet stays reachable from anywhere (pre-0.3 / hand-launched)", () => {
    expect(resolveSeatIn(seats, "legacy", "alpha")).toBe("dddd4444");
    expect(resolveSeatIn(seats, "legacy", "beta")).toBe("dddd4444");
  });
});

describe("parseSeatTarget", () => {
  test("splits on the first slash only", () => {
    expect(parseSeatTarget("beta/builder")).toEqual({ fleet: "beta", target: "builder" });
    expect(parseSeatTarget("beta/a/b")).toEqual({ fleet: "beta", target: "a/b" });
  });
  test("a bare target, a leading slash, and a trailing slash are all fleet-less", () => {
    expect(parseSeatTarget("builder")).toEqual({ fleet: null, target: "builder" });
    expect(parseSeatTarget("/builder")).toEqual({ fleet: null, target: "/builder" });
    expect(parseSeatTarget("beta/")).toEqual({ fleet: null, target: "beta/" });
  });
});

describe("filterByFleet", () => {
  test("keeps own fleet and unlabeled seats, drops other fleets", () => {
    const seats = [{ fleet: "a" }, { fleet: "b" }, { fleet: null }, {}];
    expect(filterByFleet(seats, "a")).toEqual([{ fleet: "a" }, { fleet: null }, {}]);
  });
});
