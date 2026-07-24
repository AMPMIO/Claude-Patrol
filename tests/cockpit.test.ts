import { test, expect, describe } from "bun:test";
import { cockpitCommands, STATUS_HINTS, PROMOTE_KEY } from "../src/commands/cockpit.ts";

// The command list is pure data (tmux is never touched); assert the exact
// sequence a live `patrol cockpit` would run. Mirrors tests/launcher.test.ts's
// `tmuxCommands` coverage.

describe("cockpitCommands", () => {
  test("4-seat cold start: rename first, join the rest, layout, borders, hints, one bind", () => {
    const cmds = cockpitCommands(["orchestrator", "executor", "scout", "probe"], false);

    // The first seat window BECOMES the cockpit: label its pane, then rename it.
    expect(cmds[0]).toEqual(["set-option", "-p", "-t", "patrol:orchestrator", "@seat", "orchestrator"]);
    expect(cmds[1]).toEqual(["rename-window", "-t", "patrol:orchestrator", "cockpit"]);

    // Each remaining seat is labelled, then its pane is MOVED in (process-preserving).
    for (const s of ["executor", "scout", "probe"]) {
      expect(cmds).toContainEqual(["set-option", "-p", "-t", `patrol:${s}`, "@seat", s]);
      expect(cmds).toContainEqual(["join-pane", "-s", `patrol:${s}`, "-t", "patrol:cockpit"]);
    }
    // Exactly 3 joins for 4 seats — the first is renamed, not joined.
    expect(cmds.filter((c) => c[0] === "join-pane")).toHaveLength(3);

    // One big main pane on top, the rest tiled below.
    expect(cmds).toContainEqual(["select-layout", "-t", "patrol:cockpit", "main-horizontal"]);

    // Every join happens BEFORE the layout is applied.
    const lastJoin = cmds.map((c) => c[0]).lastIndexOf("join-pane");
    const layoutIdx = cmds.findIndex((c) => c[0] === "select-layout");
    expect(lastJoin).toBeGreaterThanOrEqual(0);
    expect(lastJoin).toBeLessThan(layoutIdx);

    // Labelled previews.
    expect(cmds).toContainEqual(["set-option", "-w", "-t", "patrol:cockpit", "pane-border-status", "top"]);
    const borderFmt = cmds.find((c) => c[0] === "set-option" && c[4] === "pane-border-format");
    expect(borderFmt?.[5]).toContain("#{@seat}");
    expect(borderFmt?.[5]).toContain("#{pane_index}");

    // Key hints in the session status bar.
    const statusLeft = cmds.find((c) => c[3] === "status-left");
    expect(statusLeft).toEqual(["set-option", "-t", "patrol", "status-left", STATUS_HINTS]);
    for (const hint of ["focus", "zoom", "main", "detach", PROMOTE_KEY]) {
      expect(STATUS_HINTS).toContain(hint);
    }

    // Exactly ONE added binding: promote the focused pane to the main slot.
    const binds = cmds.filter((c) => c[0] === "bind-key");
    expect(binds).toHaveLength(1);
    expect(binds[0]).toEqual(["bind-key", PROMOTE_KEY, "swap-pane", "-t", "{top-left}"]);

    // Ends by landing on the cockpit window.
    expect(cmds[cmds.length - 1]).toEqual(["select-window", "-t", "patrol:cockpit"]);
  });

  test("idempotent re-run: cockpit exists, no seat windows -> no rename/join, still re-applies the view", () => {
    const cmds = cockpitCommands([], true);
    expect(cmds.some((c) => c[0] === "rename-window")).toBe(false);
    expect(cmds.some((c) => c[0] === "join-pane")).toBe(false);
    // The whole chrome is still re-applied — that is what makes a re-run safe.
    expect(cmds).toContainEqual(["select-layout", "-t", "patrol:cockpit", "main-horizontal"]);
    expect(cmds).toContainEqual(["set-option", "-w", "-t", "patrol:cockpit", "pane-border-status", "top"]);
    expect(cmds.filter((c) => c[0] === "bind-key")).toHaveLength(1);
  });

  test("cockpit exists with a straggler seat window -> joins it, never renames", () => {
    const cmds = cockpitCommands(["latecomer"], true);
    expect(cmds.some((c) => c[0] === "rename-window")).toBe(false);
    expect(cmds).toContainEqual(["set-option", "-p", "-t", "patrol:latecomer", "@seat", "latecomer"]);
    expect(cmds).toContainEqual(["join-pane", "-s", "patrol:latecomer", "-t", "patrol:cockpit"]);
    expect(cmds.filter((c) => c[0] === "join-pane")).toHaveLength(1);
  });
});
