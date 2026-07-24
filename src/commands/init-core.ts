// Pure builders behind `patrol init`: wizard answers -> PatrolConfig -> YAML
// string, per-role prompt generation, .gitignore de-dupe, and the AI-assist
// JSON parse. Nothing here reads stdin, spawns a process, or touches disk —
// init.ts owns all of that. Keeping it pure is what makes tests/init.test.ts
// assert a valid, round-tripping config without a real terminal or a live
// `claude -p`.

import type { PatrolConfig, SeatSpec } from "../../shared/types.ts";

// The three topologies shape the generated prompts, not the seat set:
//  - swarm:        flat peers, no orchestrator; seats coordinate directly.
//  - orchestrated: one orchestrator routes work to workers; workers report up.
//  - tiered:       orchestrated + an explicit cheap-bulk tier (codex) below.
export type Topology = "swarm" | "orchestrated" | "tiered";
export const TOPOLOGIES: readonly Topology[] = ["swarm", "orchestrated", "tiered"];

// The seat's job. Drives the prompt, and the recommended model/backend/profile
// defaults. Free-text `role` on the seat is a human label; category is the
// discipline it inherits.
export type RoleCategory = "orchestrator" | "implementer" | "reviewer" | "scout" | "bulk";
export const ROLE_CATEGORIES: readonly RoleCategory[] = [
  "orchestrator",
  "implementer",
  "reviewer",
  "scout",
  "bulk",
];

export interface SeatAnswers {
  name: string;
  role: string; // free-text label written to the seat's `role:` field
  category: RoleCategory; // drives the prompt + the recommended defaults
  model: string;
  backend: NonNullable<SeatSpec["backend"]>;
  profile: string; // "lite" | "peer" | "full"
}

export interface InitAnswers {
  topology: Topology;
  seats: SeatAnswers[];
}

export const BACKENDS: readonly NonNullable<SeatSpec["backend"]>[] = [
  "tmux",
  "bg",
  "current",
  "codex",
  "headless",
];
export const PROFILES = ["lite", "peer", "full"] as const;

// --- recommendations (the project's model-routing convention, baked in) -----
// High-taste model orchestrates (fable/opus); opus implements + reviews; codex
// (gpt-5.6-terra) does bulk; sonnet scouts. tmux is the proven push path, so it
// is the default for every seat that can receive pushes. `full` keeps a real
// work seat's toolchain; scout/bulk run lean.

export function recommendModel(category: RoleCategory): string {
  switch (category) {
    case "orchestrator":
      return "opus"; // fable or opus; opus is the cheaper high-taste default
    case "implementer":
    case "reviewer":
      return "opus";
    case "scout":
      return "sonnet";
    case "bulk":
      return "gpt-5.6-terra";
  }
}

export function recommendBackend(category: RoleCategory): NonNullable<SeatSpec["backend"]> {
  return category === "bulk" ? "codex" : "tmux";
}

export function recommendProfile(category: RoleCategory): string {
  return category === "scout" ? "peer" : "full";
}

export function defaultRoleLabel(category: RoleCategory): string {
  return category === "orchestrator" ? "lead" : category;
}

// --- per-role prompt generation ---------------------------------------------
// Each prompt encodes the fleet discipline: implementers work in worktrees,
// ship a failing-case test, report to the orchestrator, and set_state as they
// go; the orchestrator plans/reviews/routes and does not implement.

interface PromptContext {
  self: string;
  topology: Topology;
  orchestrator: string | null; // null in swarm topology
  peers: string[]; // every other seat name
  workers: string[]; // implementer + bulk seat names (for the orchestrator to route to)
}

function joinNames(names: string[]): string {
  if (names.length === 0) return "your peers";
  if (names.length === 1) return names[0]!;
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

function orchestratorPrompt(ctx: PromptContext): string {
  const targets = ctx.workers.length > 0 ? joinNames(ctx.workers) : joinNames(ctx.peers);
  return (
    `You are the fleet orchestrator (${ctx.self}). Plan the work, break it into scoped tasks, ` +
    `and route each task to the right seat (${targets}) with a real brief: the context, the why, ` +
    `and what done looks like. Do NOT implement yourself — decompose, route, review, integrate. ` +
    `Hold a high bar: send substandard work back with specifics. Track the fleet with patrol status ` +
    `and message seats with patrol send. Set your own state as you go.`
  );
}

function implementerPrompt(ctx: PromptContext): string {
  const reportTo =
    ctx.topology === "swarm"
      ? `Coordinate directly with your peers (${joinNames(ctx.peers)}) via patrol send — there is no orchestrator, so claim your slice, avoid collisions, and keep peers informed`
      : `Work only on tasks ${ctx.orchestrator ?? "the orchestrator"} routes to you, and report each result back to ${ctx.orchestrator ?? "the orchestrator"} via patrol send`;
  return (
    `You are an implementer seat (${ctx.self}). ${reportTo}. For every task: create a git worktree, ` +
    `make the smallest correct change, ship a failing-case test that proves it, run the checks, then ` +
    `report. Set your state (working / blocked / done) as you go. Escalate rather than guess when a ` +
    `decision is above your tier. Do not touch another seat's worktree.`
  );
}

function reviewerPrompt(ctx: PromptContext): string {
  const reportTo = ctx.orchestrator ?? "the fleet";
  return (
    `You are the reviewer seat (${ctx.self}). Review the diffs, plans, and configs the fleet produces. ` +
    `Output defect lists ranked by severity: every finding gets a file:line, a concrete failure ` +
    `scenario, and a fix. No praise padding — if nothing is wrong, say so in one line. Report findings ` +
    `to ${reportTo}. Set your state as you go.`
  );
}

function scoutPrompt(ctx: PromptContext): string {
  const reportTo = ctx.orchestrator ?? "the fleet";
  return (
    `You are the scout seat (${ctx.self}). Do read-only research and codebase exploration on request: ` +
    `locate code, map dependencies, gather signals, and summarize for ${reportTo}. Start broad, narrow ` +
    `down, cite file:line. Do NOT modify files. Set your state as you go.`
  );
}

function bulkPrompt(ctx: PromptContext): string {
  const reportTo = ctx.orchestrator ?? "the fleet";
  return (
    `You are the bulk seat (${ctx.self}), a codex worker for mechanical volume: renames, format ` +
    `conversions, applying a settled pattern across many files. Take scoped tasks from ${reportTo}, ` +
    `follow the given pattern exactly, and report back via patrol send. Flag anything that needs ` +
    `judgment instead of guessing — return it up rather than improvising.`
  );
}

export function generatePrompt(category: RoleCategory, ctx: PromptContext): string {
  switch (category) {
    case "orchestrator":
      return orchestratorPrompt(ctx);
    case "reviewer":
      return reviewerPrompt(ctx);
    case "scout":
      return scoutPrompt(ctx);
    case "bulk":
      return bulkPrompt(ctx);
    case "implementer":
      return implementerPrompt(ctx);
  }
}

// --- answers -> PatrolConfig ------------------------------------------------

export function buildConfig(answers: InitAnswers): PatrolConfig {
  const seats = answers.seats;
  const orchestrator = seats.find((s) => s.category === "orchestrator")?.name ?? null;
  const workers = seats
    .filter((s) => s.category === "implementer" || s.category === "bulk")
    .map((s) => s.name);

  const built: SeatSpec[] = seats.map((seat) => {
    const ctx: PromptContext = {
      self: seat.name,
      topology: answers.topology,
      orchestrator: answers.topology === "swarm" ? null : orchestrator,
      peers: seats.filter((s) => s.name !== seat.name).map((s) => s.name),
      workers,
    };
    const prompt = generatePrompt(seat.category, ctx);

    const spec: SeatSpec = {
      name: seat.name,
      role: seat.role,
      model: seat.model,
      backend: seat.backend,
    };
    // A codex adapter seat ignores profiles (compose.ts) — omit it so the file
    // stays honest about what actually takes effect.
    if (seat.backend !== "codex") spec.profile = seat.profile;
    spec.prompt = prompt;
    return spec;
  });

  return { seats: built };
}

// --- PatrolConfig -> YAML string --------------------------------------------
// Emits the minimal-indentation subset src/launcher/yaml.ts parses back, in a
// fixed, readable key order. It does NOT emit inline profile maps — generated
// configs use string presets — so a codex/object-profile value throws loudly
// rather than serialize to something the parser would mis-read.

const SCALAR_BARE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const RESERVED = new Set(["true", "false", "null", "~", "yes", "no", "on", "off"]);

export function yamlScalar(v: string | number): string {
  if (typeof v === "number") return String(v);
  const s = v;
  if (s !== "" && SCALAR_BARE.test(s) && !RESERVED.has(s) && !/^-?\d+$/.test(s)) {
    return s;
  }
  // Quote. The parser strips one pair of matching quotes with no escape
  // handling, so pick the quote char the value does not contain.
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  throw new Error(
    `cannot serialize a scalar containing both quote types (the minimal YAML ` +
      `parser has no escapes): ${s.slice(0, 60)}`,
  );
}

// Fixed emit order — every optional field skipped when undefined.
const SEAT_KEY_ORDER: (keyof SeatSpec)[] = [
  "name",
  "role",
  "model",
  "cwd",
  "backend",
  "ports",
  "profile",
  "prompt",
  "sandbox",
];

function serializeSeat(seat: SeatSpec): string[] {
  const out: string[] = [];
  let first = true;
  for (const key of SEAT_KEY_ORDER) {
    const val = seat[key];
    if (val === undefined) continue;
    if (key === "profile" && typeof val === "object") {
      throw new Error("serializeConfig only emits string profile presets, not inline profile maps");
    }
    const prefix = first ? "  - " : "    ";
    out.push(`${prefix}${key}: ${yamlScalar(val as string | number)}`);
    first = false;
  }
  return out;
}

export function configHeader(topology: Topology): string {
  return [
    "# patrol.yaml — generated by `patrol init`.",
    "# Launch with: patrol up   (then check the board: patrol status)",
    "#",
    "# Every seat MUST name a model — a seat never boots on the default model",
    "# (that would leak the expensive Fable default; the launcher hard-errors).",
    `# Topology: ${topology}.`,
  ].join("\n");
}

export function serializeConfig(config: PatrolConfig, header?: string): string {
  const lines: string[] = [];
  if (header) lines.push(header);
  lines.push("seats:");
  for (const seat of config.seats) lines.push(...serializeSeat(seat));
  return lines.join("\n") + "\n";
}

// --- .gitignore de-dupe -----------------------------------------------------
// patrol.yaml is per-machine fleet config, not source — ignore it. Append the
// entry only if no existing line already ignores exactly `patrol.yaml`.

export interface GitignoreMerge {
  content: string;
  changed: boolean;
}

export function mergeGitignore(existing: string | null): GitignoreMerge {
  const ENTRY = "patrol.yaml";
  if (existing === null) {
    return { content: `${ENTRY}\n`, changed: true };
  }
  const already = existing.split("\n").some((line) => line.trim() === ENTRY);
  if (already) return { content: existing, changed: false };
  const sep = existing.endsWith("\n") || existing === "" ? "" : "\n";
  return { content: `${existing}${sep}${ENTRY}\n`, changed: true };
}

// --- AI-assist JSON parse (pure; testable without spawning claude) ----------
// `claude -p --output-format json` wraps the model's answer in an envelope
// { type:"result", result:"<text>", ... }. The model is asked to answer with a
// bare JSON fleet object; extract it from either the envelope's `result` or the
// raw text, then coerce to InitAnswers defaults the wizard confirms. Anything
// malformed returns null so init.ts falls back to the plain wizard.

function firstJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++; // skip escaped char inside a JSON string
      else if (ch === quote) quote = "";
    } else if (ch === '"') {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function coerceCategory(v: unknown): RoleCategory {
  return typeof v === "string" && (ROLE_CATEGORIES as readonly string[]).includes(v)
    ? (v as RoleCategory)
    : "implementer";
}

function coerceBackend(v: unknown, category: RoleCategory): NonNullable<SeatSpec["backend"]> {
  return typeof v === "string" && (BACKENDS as readonly string[]).includes(v)
    ? (v as NonNullable<SeatSpec["backend"]>)
    : recommendBackend(category);
}

function coerceProfile(v: unknown, category: RoleCategory): string {
  return typeof v === "string" && (PROFILES as readonly string[]).includes(v)
    ? v
    : recommendProfile(category);
}

export function parseAiFleet(claudeStdout: string): InitAnswers | null {
  const envelope = firstJsonObject(claudeStdout);
  if (envelope === null) return null;
  // The envelope may itself be the fleet, or carry it as a `result` string.
  let fleet: unknown = envelope;
  if (
    typeof envelope === "object" &&
    envelope !== null &&
    typeof (envelope as Record<string, unknown>).result === "string"
  ) {
    fleet = firstJsonObject((envelope as Record<string, unknown>).result as string);
  }
  if (typeof fleet !== "object" || fleet === null) return null;
  const obj = fleet as Record<string, unknown>;
  const rawSeats = obj.seats;
  if (!Array.isArray(rawSeats) || rawSeats.length === 0) return null;

  const topology: Topology = (TOPOLOGIES as readonly string[]).includes(obj.topology as string)
    ? (obj.topology as Topology)
    : "orchestrated";

  const seats: SeatAnswers[] = [];
  for (let i = 0; i < rawSeats.length; i++) {
    const s = rawSeats[i];
    if (typeof s !== "object" || s === null) continue;
    const r = s as Record<string, unknown>;
    const category = coerceCategory(r.category);
    const name = typeof r.name === "string" && r.name.trim() !== "" ? r.name.trim() : `seat-${i + 1}`;
    seats.push({
      name,
      role: typeof r.role === "string" && r.role.trim() !== "" ? r.role.trim() : defaultRoleLabel(category),
      category,
      model: typeof r.model === "string" && r.model.trim() !== "" ? r.model.trim() : recommendModel(category),
      backend: coerceBackend(r.backend, category),
      profile: coerceProfile(r.profile, category),
    });
  }
  if (seats.length === 0) return null;
  return { topology, seats };
}

// The one-shot prompt handed to `claude -p`. Kept here (pure) so the exact ask
// is reviewable and stable. Signals are the cheap repo context init.ts gathers.
export function buildAiPrompt(goal: string, signals: string): string {
  return (
    `You are configuring a Claude-Patrol fleet (standing Claude Code seats defined in patrol.yaml).\n\n` +
    `The user's goal for this fleet:\n${goal}\n\n` +
    `Repository signals:\n${signals}\n\n` +
    `Recommend a fleet. Conventions: a high-taste model (fable or opus) orchestrates; opus implements ` +
    `and reviews; a codex seat (backend "codex", model "gpt-5.6-terra") does bulk mechanical work; ` +
    `sonnet scouts. Default backend "tmux". profile "full" for real work seats, "peer"/"lite" for lean. ` +
    `Every seat MUST have a model.\n\n` +
    `Respond with ONLY a JSON object, no prose, of shape:\n` +
    `{"topology":"swarm|orchestrated|tiered","seats":[{"name":string,"role":string,` +
    `"category":"orchestrator|implementer|reviewer|scout|bulk","model":string,` +
    `"backend":"tmux|bg|current|codex|headless","profile":"lite|peer|full"}]}`
  );
}
