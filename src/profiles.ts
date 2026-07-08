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

// The full --settings overlay object (enabledPlugins + raw settings merged
// last), or null when there is nothing to write (profile=full/none-override
// AND no raw settings).
export function buildSettingsOverlay(
  resolved: ResolvedProfile,
  installed: Record<string, boolean>,
): Record<string, unknown> | null {
  const enabled = buildEnabledPlugins(resolved.plugins, installed);
  const hasRaw = Object.keys(resolved.settings).length > 0;
  if (enabled === null && !hasRaw) return null;
  return {
    ...(enabled === null ? {} : { enabledPlugins: enabled }),
    ...resolved.settings,
  };
}
