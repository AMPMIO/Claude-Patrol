import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseYaml, parsePatrolConfig } from "../src/launcher/yaml.ts";
import {
  resolveProfile, buildEnabledPlugins, buildSettingsOverlay, matchPlugin, NAMED_PROFILES, GUARD_MATCHER,
} from "../src/profiles.ts";
import {
  validateConfig, applyFleetBudget, planSeat, composeSeat, shQuote, seatShellLine, tmuxCommands, CODEX_SEAT, HEADLESS_SEAT,
  CHECKPOINT_GUARD, leaseFile, selectBgPidsToKill, patrolMcpConfig, type SeatPlan, type ComposePaths,
} from "../src/launcher/compose.ts";
import { seatMarker, SEAT_TOKEN_ENV, LEASE_FILE_ENV, type PatrolConfig, type SeatSpec } from "../shared/types.ts";

// v0.2.9: the guard hook block every Claude seat's --settings overlay now carries.
const GUARD_HOOKS = {
  PreToolUse: [
    { matcher: GUARD_MATCHER, hooks: [{ type: "command", command: `bun "${CHECKPOINT_GUARD}"` }] },
  ],
};

const INSTALLED = {
  "caveman@caveman": true,
  "ponytail@ponytail": false,
  "context7@claude-plugins-official": true,
};

// --- YAML parser ------------------------------------------------------------

describe("yaml", () => {
  test("parses nested maps, block seq, inline list, quoted prompt", () => {
    const doc = parseYaml(`
seats:
  - name: orchestrator
    model: opus
    profile: full
    prompt: "delegate, don't implement"
  - name: executor
    model: opus
    profile:
      plugins: [caveman, ponytail]
      mcp: patrol
`) as any;
    expect(doc.seats).toHaveLength(2);
    expect(doc.seats[0]).toMatchObject({ name: "orchestrator", model: "opus", profile: "full" });
    expect(doc.seats[0].prompt).toBe("delegate, don't implement");
    expect(doc.seats[1].profile).toEqual({ plugins: ["caveman", "ponytail"], mcp: "patrol" });
  });

  test("coerces bool/int, strips comments", () => {
    const doc = parseYaml(`
a: true       # trailing comment
b: 7
c: hello
`) as any;
    expect(doc).toEqual({ a: true, b: 7, c: "hello" });
  });

  test("shipped example parses to 3 valid seats", () => {
    const src = readFileSync(join(import.meta.dir, "..", "patrol.yaml.example"), "utf8");
    const cfg = parsePatrolConfig(src);
    expect(cfg.seats.map((s) => s.name)).toEqual(["orchestrator", "executor", "scout"]);
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  test("rejects non-mapping top level", () => {
    expect(() => parsePatrolConfig("- a\n- b")).toThrow(/seats/);
  });
});

// --- fleet-level budget (Codex #2: no longer silently dropped) ---------------

describe("fleet budget parse + default", () => {
  test("top-level budget_usd + budget_alert_to round-trip into PatrolConfig", () => {
    const cfg = parsePatrolConfig(`
budget_usd: 25
budget_alert_to: lead
seats:
  - name: a
    model: opus
`);
    expect(cfg.budget_usd).toBe(25);
    expect(cfg.budget_alert_to).toBe("lead");
    expect(cfg.seats).toHaveLength(1);
  });

  test("a float budget (parsed as a string by the scalar reader) is normalized to a number", () => {
    expect(parsePatrolConfig("budget_usd: 2.50\nseats:\n  - name: a\n    model: opus\n").budget_usd).toBe(2.5);
  });

  test("rejects a non-positive / non-numeric budget_usd and an empty budget_alert_to", () => {
    expect(() => parsePatrolConfig("budget_usd: 0\nseats:\n  - name: a\n    model: opus\n")).toThrow(/positive number/);
    expect(() => parsePatrolConfig("budget_usd: -5\nseats:\n  - name: a\n    model: opus\n")).toThrow(/positive number/);
    expect(() => parsePatrolConfig("budget_usd: nope\nseats:\n  - name: a\n    model: opus\n")).toThrow(/positive number/);
    expect(() => parsePatrolConfig('budget_alert_to: ""\nseats:\n  - name: a\n    model: opus\n')).toThrow(/budget_alert_to/);
  });

  test("applyFleetBudget: fleet cap is the DEFAULT; a per-seat budget_usd overrides it", () => {
    const seats = applyFleetBudget({
      budget_usd: 10,
      seats: [
        { name: "inherits", model: "opus" },
        { name: "owns", model: "opus", budget_usd: 3 },
      ],
    });
    expect(seats.find((s) => s.name === "inherits")!.budget_usd).toBe(10); // fleet default
    expect(seats.find((s) => s.name === "owns")!.budget_usd).toBe(3); // per-seat wins
  });

  test("applyFleetBudget: no fleet cap leaves seats untouched (no accidental cap)", () => {
    const original: SeatSpec[] = [{ name: "a", model: "opus" }];
    const seats = applyFleetBudget({ seats: original });
    expect(seats).toBe(original); // same reference — nothing folded
    expect(seats[0]!.budget_usd).toBeUndefined();
  });
});

// --- validation -------------------------------------------------------------

function cfg(seats: SeatSpec[]): PatrolConfig {
  return { seats };
}

describe("validateConfig", () => {
  test("passes a well-formed fleet", () => {
    expect(() => validateConfig(cfg([{ name: "a", model: "opus" }]))).not.toThrow();
  });
  test("rejects missing model (Fable-default leak guard)", () => {
    expect(() => validateConfig(cfg([{ name: "a" } as SeatSpec]))).toThrow(/no model/);
  });
  test("rejects empty seats", () => {
    expect(() => validateConfig(cfg([]))).toThrow(/no seats/);
  });
  test("rejects duplicate names", () => {
    expect(() => validateConfig(cfg([
      { name: "a", model: "opus" }, { name: "a", model: "sonnet" },
    ]))).toThrow(/duplicate/);
  });
  test("rejects backend current + profile", () => {
    expect(() => validateConfig(cfg([
      { name: "a", model: "opus", backend: "current", profile: "full" },
    ]))).toThrow(/re-profiled/);
  });
  test("allows backend current without profile", () => {
    expect(() => validateConfig(cfg([
      { name: "a", model: "opus", backend: "current" },
    ]))).not.toThrow();
  });
  test("rejects invalid backend", () => {
    expect(() => validateConfig(cfg([
      { name: "a", model: "opus", backend: "warp" as any },
    ]))).toThrow(/invalid backend/);
  });
  test("rejects unknown profile preset string", () => {
    expect(() => validateConfig(cfg([
      { name: "a", model: "opus", profile: "turbo" },
    ]))).toThrow(/unknown profile/);
  });
  test("rejects path-traversal / injection seat names, accepts normal ones", () => {
    for (const bad of ["../x", "/abs", "a;b", ".", "..", "a b", "a/b", "-lead", "café"]) {
      expect(() => validateConfig(cfg([{ name: bad, model: "opus" }]))).toThrow(/invalid name/);
    }
    for (const ok of ["orchestrator", "worker-1", "a", "seat.1", "A_b-2"]) {
      expect(() => validateConfig(cfg([{ name: ok, model: "opus" }]))).not.toThrow();
    }
  });
});

// --- profiles ---------------------------------------------------------------

describe("profiles", () => {
  test("named presets resolve", () => {
    expect(resolveProfile("lite")).toEqual(NAMED_PROFILES.lite!);
    expect(resolveProfile("peer")).toEqual(NAMED_PROFILES.peer!);
    expect(resolveProfile("full")).toEqual(NAMED_PROFILES.full!);
  });
  test("undefined profile -> null (inherit all)", () => {
    expect(resolveProfile(undefined)).toBeNull();
  });
  test("unknown preset string throws", () => {
    expect(() => resolveProfile("turbo")).toThrow(/unknown profile/);
  });
  test("object profile fills defaults", () => {
    expect(resolveProfile({ plugins: ["caveman"] })).toEqual({
      plugins: ["caveman"], mcp: "full", settings: {},
    });
  });
  test("matchPlugin matches short name and full key", () => {
    expect(matchPlugin("caveman@caveman", ["caveman"])).toBe(true);
    expect(matchPlugin("caveman@caveman", ["caveman@caveman"])).toBe(true);
    expect(matchPlugin("ponytail@ponytail", ["caveman"])).toBe(false);
  });
  test("buildEnabledPlugins: all->null, none->all false, subset->listed true", () => {
    expect(buildEnabledPlugins("all", INSTALLED)).toBeNull();
    expect(buildEnabledPlugins("none", INSTALLED)).toEqual({
      "caveman@caveman": false, "ponytail@ponytail": false, "context7@claude-plugins-official": false,
    });
    expect(buildEnabledPlugins(["caveman"], INSTALLED)).toEqual({
      "caveman@caveman": true, "ponytail@ponytail": false, "context7@claude-plugins-official": false,
    });
  });
  // v0.2.9: the overlay is never null any more — it carries the checkpoint guard,
  // and a seat without it could not be quiesced (checkpoint would refuse it).
  test("buildSettingsOverlay: full->guard hook only, subset->enabledPlugins, raw merged last", () => {
    expect(buildSettingsOverlay(NAMED_PROFILES.full!, INSTALLED, "/pkg/hook.ts")).toEqual({
      hooks: { PreToolUse: [{ matcher: GUARD_MATCHER, hooks: [{ type: "command", command: 'bun "/pkg/hook.ts"' }] }] },
    });
    expect(buildSettingsOverlay({ plugins: ["caveman"], mcp: "full", settings: { theme: "dark" } }, INSTALLED, CHECKPOINT_GUARD)).toEqual({
      enabledPlugins: { "caveman@caveman": true, "ponytail@ponytail": false, "context7@claude-plugins-official": false },
      theme: "dark",
      hooks: GUARD_HOOKS,
    });
  });

  test("buildSettingsOverlay: a profile's own hooks survive; the guard is APPENDED", () => {
    const mine = { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] };
    const overlay = buildSettingsOverlay(
      { plugins: "all", mcp: "full", settings: { hooks: { PreToolUse: [mine], SessionEnd: ["keep-me"] } } },
      INSTALLED,
      CHECKPOINT_GUARD,
    );
    expect(overlay.hooks).toEqual({
      SessionEnd: ["keep-me"],
      PreToolUse: [mine, ...GUARD_HOOKS.PreToolUse],
    });
  });
});

// --- argv composition -------------------------------------------------------

function plan(seat: SeatSpec): SeatPlan {
  return planSeat(seat, INSTALLED, "/work");
}
const SET = "/prof/x.settings.json";
const MCP = "/prof/x.mcp.json";
function pathsFor(p: SeatPlan): ComposePaths {
  return {
    settingsFile: p.settingsOverlay ? SET : null,
    // materialize() writes the patrol mcp file for every seat except mcp:"none".
    mcpConfigFile: p.resolved?.mcp !== "none" ? MCP : null,
  };
}
// Patrol mounted ADDITIVELY for full/no-profile seats (keeps global MCP servers).
const ADD_MCP = ["--mcp-config", MCP];

// Channel-push flag pair every non-mcp:none seat must carry — without it,
// inbound messages never wake the session (check_messages fallback only).
const CHAN = ["--dangerously-load-development-channels", "server:patrol"];

describe("composeSeat argv+env", () => {
  test("codex seat plans and composes the adapter argv without Claude extras", () => {
    const p = plan({ name: "codex", role: "reviewer", model: "gpt-5.6-terra", backend: "codex", profile: "peer", prompt: "review changes" });
    expect(() => validateConfig(cfg([p.spec]))).not.toThrow();
    const { argv, env } = composeSeat(p, pathsFor(p), "cp-0375a012");
    expect(argv).toEqual(["bun", CODEX_SEAT, "--cwd", "/work", "--role", "reviewer", "--model", "gpt-5.6-terra", "--prompt", "review changes"]);
    expect(env).toEqual({ CLAUDE_PATROL_ROLE: "reviewer", CLAUDE_PATROL_MODEL: "gpt-5.6-terra" });
  });

  test("headless seat plans and composes the adapter argv without Claude extras", () => {
    const p = plan({ name: "headless", role: "answerer", model: "sonnet", backend: "headless", profile: "peer", prompt: "answer questions" });
    expect(() => validateConfig(cfg([p.spec]))).not.toThrow();
    const { argv, env } = composeSeat(p, pathsFor(p), "cp-0375a012");
    // Like codex: a bun adapter daemon, no --name/marker/settings/mcp Claude argv.
    expect(argv).toEqual(["bun", HEADLESS_SEAT, "--cwd", "/work", "--role", "answerer", "--model", "sonnet", "--prompt", "answer questions"]);
    expect(env).toEqual({ CLAUDE_PATROL_ROLE: "answerer", CLAUDE_PATROL_MODEL: "sonnet" });
  });

  // v0.2.9: a `full` seat overrides no plugins and no settings, but it STILL gets a
  // --settings overlay now — that file is what installs the checkpoint guard hook.
  test("tmux full seat: additive mcp + guard-only settings overlay, prompt positional", () => {
    const p = plan({ name: "orchestrator", role: "lead", model: "opus", backend: "tmux", profile: "full", prompt: "go" });
    expect(p.settingsOverlay).toEqual({ hooks: GUARD_HOOKS });
    const { argv, env } = composeSeat(p, pathsFor(p));
    expect(argv).toEqual(["claude", "--model", "opus", "--name", "orchestrator", ...ADD_MCP, ...CHAN, "--settings", SET, "--", "go"]);
    expect(env).toEqual({
      CLAUDE_PATROL_ROLE: "lead", CLAUDE_PATROL_MODEL: "opus", CLAUDE_PATROL_PROFILE: "full",
      [LEASE_FILE_ENV]: leaseFile("orchestrator"),
    });
  });

  test("custom subset tmux seat: mcp=patrol + settings overlay, role defaults to name", () => {
    const p = plan({ name: "executor", model: "opus", backend: "tmux", profile: { plugins: ["caveman", "ponytail"], mcp: "patrol" } });
    const { argv, env } = composeSeat(p, pathsFor(p));
    expect(argv).toEqual([
      "claude", "--model", "opus", "--name", "executor",
      "--strict-mcp-config", "--mcp-config", MCP,
      ...CHAN,
      "--settings", SET,
    ]);
    expect(env).toEqual({
      CLAUDE_PATROL_ROLE: "executor", CLAUDE_PATROL_MODEL: "opus", CLAUDE_PATROL_PROFILE: "custom",
      [LEASE_FILE_ENV]: leaseFile("executor"),
    });
  });

  test("bg peer seat: --bg + empty-plugin settings + patrol mcp", () => {
    const p = plan({ name: "scout", model: "sonnet", backend: "bg", profile: "peer" });
    const { argv, env } = composeSeat(p, pathsFor(p));
    expect(argv).toEqual([
      "claude", "--model", "sonnet", "--name", "scout", "--bg",
      "--strict-mcp-config", "--mcp-config", MCP,
      ...CHAN,
      "--settings", SET,
    ]);
    expect(env.CLAUDE_PATROL_PROFILE).toBe("peer");
  });

  test("lite seat: empty mcp inline, no PROFILE omitted only when profile absent", () => {
    const p = plan({ name: "tmp", model: "haiku", profile: "lite" });
    const { argv } = composeSeat(p, pathsFor(p));
    expect(argv).toEqual([
      "claude", "--model", "haiku", "--name", "tmp",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--settings", SET,
    ]);
  });

  // A no-profile seat inherits everything, so its overlay is the guard hook and
  // nothing else — but it must exist, or the seat is unguarded.
  test("no-profile seat: plain claude + channel flag + guard settings, no PROFILE env", () => {
    const p = plan({ name: "bare", model: "opus" });
    expect(p.resolved).toBeNull(); // still inherits (additive MCP), overlay notwithstanding
    expect(p.settingsOverlay).toEqual({ hooks: GUARD_HOOKS });
    const { argv, env } = composeSeat(p, pathsFor(p));
    expect(argv).toEqual(["claude", "--model", "opus", "--name", "bare", ...ADD_MCP, ...CHAN, "--settings", SET]);
    expect(env).toEqual({
      CLAUDE_PATROL_ROLE: "bare", CLAUDE_PATROL_MODEL: "opus",
      [LEASE_FILE_ENV]: leaseFile("bare"),
    });
  });
});

// --- v0.2.9 checkpoint guard wiring -----------------------------------------

describe("checkpoint guard wiring", () => {
  test("the hook path in the overlay is absolute and points at checkpoint-guard.ts", () => {
    expect(CHECKPOINT_GUARD.startsWith("/")).toBe(true);
    expect(CHECKPOINT_GUARD.endsWith("/plugin/hooks/checkpoint-guard.ts")).toBe(true);
    expect(existsSync(CHECKPOINT_GUARD)).toBe(true); // a settings file naming a missing hook guards nothing
  });

  for (const backend of ["tmux", "bg", "current"] as const) {
    test(`${backend} seat gets BOTH the lease env and the guard hook`, () => {
      const p = plan({ name: `s-${backend}`, model: "opus", backend });
      expect(p.settingsOverlay!.hooks).toEqual(GUARD_HOOKS);
      const { env } = composeSeat(p, pathsFor(p));
      expect(env[LEASE_FILE_ENV]).toBe(leaseFile(`s-${backend}`));
    });
  }

  test("each seat gets its OWN lease file (one seat's checkpoint never quiesces another)", () => {
    const a = plan({ name: "a", model: "opus" });
    const b = plan({ name: "b", model: "opus" });
    expect(composeSeat(a, pathsFor(a)).env[LEASE_FILE_ENV])
      .not.toBe(composeSeat(b, pathsFor(b)).env[LEASE_FILE_ENV]);
  });

  // Adapter seats are not Claude sessions: nothing to hook, nothing to quiesce.
  // They register unguarded and `patrol checkpoint` refuses them by design.
  for (const backend of ["codex", "headless"] as const) {
    test(`${backend} adapter seat gets NEITHER the lease env NOR a settings overlay`, () => {
      const p = plan({ name: "a", role: "adapter", model: "opus", backend });
      expect(p.settingsOverlay).toBeNull();
      expect(composeSeat(p, pathsFor(p)).env[LEASE_FILE_ENV]).toBeUndefined();
    });
  }
});

// --- Layer-1 seat-token marker injection -----------------------------------

describe("composeSeat seat-token marker", () => {
  const TOKEN = "cp-0375a012";
  const MARKER = seatMarker(TOKEN);

  test("appends marker to an existing prompt and sets SEAT_TOKEN_ENV", () => {
    const p = plan({ name: "orchestrator", role: "lead", model: "opus", profile: "full", prompt: "go" });
    const { argv, env } = composeSeat(p, pathsFor(p), TOKEN);
    expect(argv).toEqual(["claude", "--model", "opus", "--name", "orchestrator", ...ADD_MCP, ...CHAN, "--settings", SET, "--", `go\n\n${MARKER}`]);
    expect(env[SEAT_TOKEN_ENV]).toBe(TOKEN);
  });

  test("synthesizes a minimal prompt when the seat has none", () => {
    const p = plan({ name: "worker-1", role: "worker", model: "sonnet" });
    const { argv, env } = composeSeat(p, pathsFor(p), TOKEN);
    expect(argv).toEqual(["claude", "--model", "sonnet", "--name", "worker-1", ...ADD_MCP, ...CHAN, "--settings", SET, "--", `${MARKER} You are seat worker. Await instructions.`]);
    expect(env[SEAT_TOKEN_ENV]).toBe(TOKEN);
  });

  test("silent seat skips BOTH marker and env even when a token is passed", () => {
    const p = plan({ name: "quiet", model: "opus", prompt: "hi", silent: true });
    const { argv, env } = composeSeat(p, pathsFor(p), TOKEN);
    expect(argv).toEqual(["claude", "--model", "opus", "--name", "quiet", ...ADD_MCP, ...CHAN, "--settings", SET, "--", "hi"]);
    expect(env[SEAT_TOKEN_ENV]).toBeUndefined();
  });

  test("no token passed -> no marker, no env (back-compat)", () => {
    const p = plan({ name: "bare", model: "opus", prompt: "hi" });
    const { argv, env } = composeSeat(p, pathsFor(p));
    expect(argv).toEqual(["claude", "--model", "opus", "--name", "bare", ...ADD_MCP, ...CHAN, "--settings", SET, "--", "hi"]);
    expect(env[SEAT_TOKEN_ENV]).toBeUndefined();
  });
});

// --- budget forwarding to the /register path (Codex #2) ---------------------

describe("composeSeat budget forwarding", () => {
  test("effective per-seat budget_usd (fleet default folded in) → CLAUDE_PATROL_BUDGET_USD env", () => {
    const [seat] = applyFleetBudget({ budget_usd: 12, seats: [{ name: "w", model: "opus" }] });
    const p = plan(seat!);
    const { env } = composeSeat(p, pathsFor(p));
    expect(env.CLAUDE_PATROL_BUDGET_USD).toBe("12");
  });

  test("fleet budget_alert_to → CLAUDE_PATROL_BUDGET_ALERT_TO env (round-trips to /register)", () => {
    const p = plan({ name: "w", model: "opus" });
    const { env } = composeSeat(p, pathsFor(p), null, "lead");
    expect(env.CLAUDE_PATROL_BUDGET_ALERT_TO).toBe("lead");
  });

  test("no alert recipient → no env key (broker keeps its default recipient)", () => {
    const p = plan({ name: "w", model: "opus" });
    const { env } = composeSeat(p, pathsFor(p));
    expect(env.CLAUDE_PATROL_BUDGET_ALERT_TO).toBeUndefined();
  });

  // The regression this pair pins: composeSeat's codex/headless early returns used to
  // build a role+model-only env, so a mixed fleet launched its adapter seats uncapped.
  for (const backend of ["codex", "headless"] as const) {
    test(`${backend} adapter seat carries the fleet cap + alert recipient in its env`, () => {
      const [seat] = applyFleetBudget({
        budget_usd: 12,
        seats: [{ name: "a", role: "adapter", model: "opus", backend }],
      });
      const p = plan(seat!);
      const { env } = composeSeat(p, pathsFor(p), "cp-0375a012", "lead");
      expect(env).toEqual({
        CLAUDE_PATROL_ROLE: "adapter",
        CLAUDE_PATROL_MODEL: "opus",
        CLAUDE_PATROL_BUDGET_USD: "12",
        CLAUDE_PATROL_BUDGET_ALERT_TO: "lead",
      });
    });

    test(`${backend} adapter seat with no budget set omits BOTH keys`, () => {
      const p = plan({ name: "a", role: "adapter", model: "opus", backend });
      const { env } = composeSeat(p, pathsFor(p), "cp-0375a012");
      expect(env).toEqual({ CLAUDE_PATROL_ROLE: "adapter", CLAUDE_PATROL_MODEL: "opus" });
    });
  }

  test("per-seat budget on an adapter seat overrides the fleet default", () => {
    const [seat] = applyFleetBudget({
      budget_usd: 12,
      seats: [{ name: "a", role: "adapter", model: "opus", backend: "headless", budget_usd: 3.5 }],
    });
    const p = plan(seat!);
    const { env } = composeSeat(p, pathsFor(p));
    expect(env.CLAUDE_PATROL_BUDGET_USD).toBe("3.5");
  });
});

// --- cwd resolution against the config directory ---------------------------

describe("planSeat cwd", () => {
  test("relative cwd resolves against the config dir, not process cwd", () => {
    expect(planSeat({ name: "a", model: "opus", cwd: "pkg/api" }, INSTALLED, "/cfg").cwd).toBe("/cfg/pkg/api");
  });
  test("absolute cwd is kept as-is", () => {
    expect(planSeat({ name: "a", model: "opus", cwd: "/abs/here" }, INSTALLED, "/cfg").cwd).toBe("/abs/here");
  });
  test("omitted cwd defaults to the config dir", () => {
    expect(planSeat({ name: "a", model: "opus" }, INSTALLED, "/cfg").cwd).toBe("/cfg");
  });
});

// --- shell quoting + tmux ---------------------------------------------------

describe("shQuote", () => {
  test("bare word unquoted, spaces + quotes wrapped", () => {
    expect(shQuote("opus")).toBe("opus");
    expect(shQuote("")).toBe("''");
    expect(shQuote("two words")).toBe("'two words'");
    expect(shQuote("it's")).toBe("'it'\\''s'");
    expect(shQuote("/a/b.json")).toBe("/a/b.json");
  });
  test("seatShellLine cds, sets env, runs argv", () => {
    const line = seatShellLine("/w s", { CLAUDE_PATROL_ROLE: "lead" }, ["claude", "--model", "opus", "hi there"]);
    expect(line).toBe("cd '/w s' && env CLAUDE_PATROL_ROLE=lead claude --model opus 'hi there'");
  });
});

describe("tmuxCommands", () => {
  test("first seat new-session, rest new-window, send-keys per seat", () => {
    const cmds = tmuxCommands([
      { name: "a", cwd: "/w", env: {}, argv: ["claude", "--model", "opus"] },
      { name: "b", cwd: "/w", env: {}, argv: ["claude", "--model", "sonnet"] },
    ]);
    expect(cmds[0]).toEqual(["new-session", "-d", "-s", "patrol", "-n", "a"]);
    expect(cmds[1]![0]).toBe("send-keys");
    expect(cmds[1]![2]).toBe("patrol:a");
    expect(cmds[1]![4]).toBe("Enter");
    expect(cmds[2]).toEqual(["new-window", "-t", "patrol", "-n", "b"]);
    expect(cmds[3]![2]).toBe("patrol:b");
  });
});

// --- bg teardown + mcp config ----------------------------------------------

describe("selectBgPidsToKill", () => {
  const live = [
    { pid: 100, sessionId: "s1", name: "scout" },
    { pid: 101, sessionId: "s2", name: "probe" },
  ];
  test("matches by sessionId first -> verified", () => {
    expect(selectBgPidsToKill([{ name: "x", sessionId: "s2", pid: null }], live)).toEqual({ verified: [101], unverified: [] });
  });
  test("falls back to name when sessionId unknown -> verified", () => {
    expect(selectBgPidsToKill([{ name: "scout", sessionId: null, pid: null }], live)).toEqual({ verified: [100], unverified: [] });
  });
  test("recorded pid whose agent is gone -> unverified (recycle risk)", () => {
    expect(selectBgPidsToKill([{ name: "ghost", sessionId: "gone", pid: 999 }], live)).toEqual({ verified: [], unverified: [999] });
  });
  test("mixed fleet splits verified from unverified", () => {
    expect(selectBgPidsToKill([
      { name: "scout", sessionId: "s1", pid: 55 },   // live -> verified 100
      { name: "ghost", sessionId: "gone", pid: 999 }, // gone -> unverified 999
    ], live)).toEqual({ verified: [100], unverified: [999] });
  });
  test("dedups and never lists a verified pid as unverified", () => {
    expect(selectBgPidsToKill([
      { name: "scout", sessionId: "s1", pid: null },
      { name: "scout", sessionId: null, pid: null },
      { name: "gone-but-same-pid", sessionId: "x", pid: 100 }, // recycled onto a verified pid
    ], live)).toEqual({ verified: [100], unverified: [] });
  });
});

test("patrolMcpConfig points bun at the seat server path", () => {
  expect(JSON.parse(patrolMcpConfig("/pkg/src/seat-server.ts"))).toEqual({
    mcpServers: { patrol: { command: "bun", args: ["/pkg/src/seat-server.ts"] } },
  });
});
