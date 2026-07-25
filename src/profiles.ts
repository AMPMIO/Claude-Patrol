// Named boot presets + per-seat plugin/settings overlay builders.
// Mirrors ccl's lite/peer/full semantics (~/.local/bin/ccl) but adds the R3
// gap: per-seat plugin SUBSETS instead of ccl's all-or-nothing toggle.

import type { ProfileSpec } from "../shared/types.ts";

export interface ResolvedProfile {
  plugins: string[] | "all" | "none";
  mcp: "none" | "patrol" | "full";
  settings: Record<string, unknown>;
}

// lite  = disposable seat: no plugins, no MCP (ccl lite).
// peer  = coordinated seat: no plugins, only the patrol seat server (ccl peer).
// full  = workhorse: everything on (ccl full).
export const NAMED_PROFILES: Record<string, ResolvedProfile> = {
  lite: { plugins: "none", mcp: "none", settings: {} },
  peer: { plugins: "none", mcp: "patrol", settings: {} },
  full: { plugins: "all", mcp: "full", settings: {} },
};

export const PRESET_NAMES = Object.keys(NAMED_PROFILES);

// undefined profile -> null = plain `claude --model X`, inherit everything
// (the ccl `full` shell path). A string must name a known preset. An object is
// a custom ProfileSpec with sensible defaults for omitted fields.
export function resolveProfile(profile: ProfileSpec | string | undefined): ResolvedProfile | null {
  if (profile === undefined) return null;
  if (typeof profile === "string") {
    const preset = NAMED_PROFILES[profile];
    if (!preset) throw new Error(`unknown profile preset "${profile}" (expected ${PRESET_NAMES.join(" | ")})`);
    return preset;
  }
  return {
    plugins: profile.plugins ?? "all",
    mcp: profile.mcp ?? "full",
    settings: profile.settings ?? {},
  };
}

// A wanted name matches an installed key by full key ("caveman@caveman") or by
// the plugin part before "@" ("caveman"), so configs can use short names.
export function matchPlugin(installedKey: string, wanted: string[]): boolean {
  if (wanted.includes(installedKey)) return true;
  const at = installedKey.indexOf("@");
  const pluginName = at === -1 ? installedKey : installedKey.slice(0, at);
  return wanted.includes(pluginName);
}

// enabledPlugins overlay for --settings. "all" -> null (inherit, no override);
// "none" -> every installed plugin false; subset -> listed true, rest false.
export function buildEnabledPlugins(
  want: string[] | "all" | "none",
  installed: Record<string, boolean>,
): Record<string, boolean> | null {
  if (want === "all") return null;
  const out: Record<string, boolean> = {};
  const wanted = want === "none" ? [] : want;
  for (const key of Object.keys(installed)) {
    out[key] = matchPlugin(key, wanted);
  }
  return out;
}

// Tool names the checkpoint guard is matched against — the mutating set. The hook
// itself inspects neither tool nor path: path/command matching is how the earlier
// deny-hook earned six proven bypasses (a `cd` defeats it), so matching stops at
// the tool name and the lease decides the rest. Kept in step with the same matcher
// in plugin/hooks/hooks.json (that copy guards MANUAL, non-launcher sessions).
export const GUARD_MATCHER = "Edit|Write|NotebookEdit|Bash";

// The full --settings overlay object. ALWAYS non-null for a Claude seat as of
// v0.2.9: the overlay is what carries the checkpoint-guard PreToolUse hook, and a
// seat without it cannot be quiesced — so `patrol checkpoint` would have to refuse
// it. enabledPlugins/raw settings behave exactly as before; they just no longer
// decide whether a file gets written. guardHookPath must be ABSOLUTE (a seat's cwd
// is arbitrary).
export function buildSettingsOverlay(
  resolved: ResolvedProfile,
  installed: Record<string, boolean>,
  guardHookPath: string,
): Record<string, unknown> {
  const enabled = buildEnabledPlugins(resolved.plugins, installed);
  // A profile's raw `hooks` is preserved and the guard APPENDED to its PreToolUse
  // list — replacing it would silently drop a user's hooks, and appending is safe
  // because a single deny decides the call no matter what the others return.
  const rawHooks = (resolved.settings.hooks ?? {}) as Record<string, unknown[]>;
  return {
    ...(enabled === null ? {} : { enabledPlugins: enabled }),
    ...resolved.settings,
    hooks: {
      ...rawHooks,
      PreToolUse: [
        ...(rawHooks.PreToolUse ?? []),
        {
          matcher: GUARD_MATCHER,
          hooks: [{ type: "command", command: `bun "${guardHookPath}"` }],
        },
      ],
    },
  };
}
