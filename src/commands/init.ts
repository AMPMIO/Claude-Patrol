// `patrol init [--ai]` — interactive setup wizard that writes a patrol.yaml to
// the current directory. All the pure logic (answers -> config -> YAML, prompt
// generation, .gitignore de-dupe, AI JSON parse) lives in init-core.ts; this
// file owns the stdin I/O, the optional one-shot `claude -p` call, and the disk
// writes. The plain wizard is the core, fully-working path; --ai only supplies
// richer defaults the user still confirms.

import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { parsePatrolConfig } from "../launcher/yaml.ts";
import { validateConfig } from "../launcher/compose.ts";
import {
  buildConfig,
  serializeConfig,
  configHeader,
  mergeGitignore,
  parseAiFleet,
  buildAiPrompt,
  recommendModel,
  recommendBackend,
  recommendProfile,
  defaultRoleLabel,
  TOPOLOGIES,
  ROLE_CATEGORIES,
  BACKENDS,
  PROFILES,
  type Topology,
  type RoleCategory,
  type SeatAnswers,
  type InitAnswers,
} from "./init-core.ts";

// Mirrors SEAT_NAME_RE in compose.ts — a UX pre-check so a bad name is caught at
// the prompt, not after the whole wizard. validateConfig stays the authority.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AI_OUTPUT_CAP = 64 * 1024;
const AI_TIMEOUT_MS = 60_000;

// --- stdin helpers ----------------------------------------------------------
// Empty input always falls back to the (always-valid) default, so an EOF/closed
// stdin resolves to defaults instead of spinning a re-ask loop. A closed stream
// (piped input that ran out, or ^D) also resolves to the default rather than
// hanging — readline never fires the `question` callback on close.

function ask(rl: Interface, q: string, def?: string): Promise<string> {
  const fallback = def ?? "";
  if ((rl as unknown as { closed?: boolean }).closed) return Promise.resolve(fallback);
  const suffix = def !== undefined && def !== "" ? ` [${def}]` : "";
  return new Promise((res) => {
    let done = false;
    const finish = (v: string) => {
      if (done) return;
      done = true;
      rl.removeListener("close", onClose);
      res(v);
    };
    const onClose = () => finish(fallback);
    rl.once("close", onClose);
    rl.question(`${q}${suffix}: `, (a) => {
      const t = a.trim();
      finish(t === "" && def !== undefined ? def : t);
    });
  });
}

async function askChoice<T extends string>(rl: Interface, q: string, options: readonly T[], def: T): Promise<T> {
  for (;;) {
    const a = await ask(rl, `${q} (${options.join("/")})`, def);
    if ((options as readonly string[]).includes(a)) return a as T;
    console.log(`  choose one of: ${options.join(", ")}`);
  }
}

async function askNumber(rl: Interface, q: string, def: number, min: number, max: number): Promise<number> {
  for (;;) {
    const a = await ask(rl, q, String(def));
    const n = Number(a);
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    console.log(`  enter a whole number between ${min} and ${max}`);
  }
}

async function askYesNo(rl: Interface, q: string, defaultYes = false): Promise<boolean> {
  const a = (await ask(rl, `${q} (y/n)`, defaultYes ? "y" : "n")).toLowerCase();
  return a === "y" || a === "yes";
}

// --- default seat template --------------------------------------------------

const BASE_NAME: Record<RoleCategory, string> = {
  orchestrator: "orchestrator",
  implementer: "impl",
  reviewer: "reviewer",
  scout: "scout",
  bulk: "bulk",
};

function templateCategories(topology: Topology, n: number): RoleCategory[] {
  if (topology === "swarm") return Array(n).fill("implementer");
  const cats: RoleCategory[] = ["orchestrator"];
  if (topology === "tiered") {
    for (let i = 0; i < Math.max(0, n - 2); i++) cats.push("implementer");
    if (n >= 2) cats.push("bulk");
  } else {
    for (let i = 1; i < n; i++) cats.push("implementer");
  }
  return cats.slice(0, n);
}

function seatFromCategory(category: RoleCategory, ordinal: number, total: number): SeatAnswers {
  const base = BASE_NAME[category];
  const name = total > 1 ? `${base}-${ordinal}` : base;
  return {
    name,
    role: defaultRoleLabel(category),
    category,
    model: recommendModel(category),
    backend: recommendBackend(category),
    profile: recommendProfile(category),
  };
}

function makeTemplate(topology: Topology, n: number): SeatAnswers[] {
  const cats = templateCategories(topology, n);
  const counts: Record<string, number> = {};
  const totals: Record<string, number> = {};
  for (const c of cats) totals[c] = (totals[c] ?? 0) + 1;
  return cats.map((c) => {
    counts[c] = (counts[c] ?? 0) + 1;
    return seatFromCategory(c, counts[c]!, totals[c]!);
  });
}

// Resize a template to n seats: truncate, or pad with implementer defaults.
function resizeTemplate(base: SeatAnswers[], topology: Topology, n: number): SeatAnswers[] {
  if (n === base.length) return base;
  if (n < base.length) return base.slice(0, n);
  const out = base.slice();
  for (let i = base.length; i < n; i++) out.push(seatFromCategory("implementer", i + 1, n));
  return out;
}

// --- AI assist (impure: repo signals + one-shot claude -p) ------------------

function gatherSignals(cwd: string): string {
  const parts: string[] = [];
  try {
    for (const f of ["README.md", "README", "readme.md", "README.markdown"]) {
      const p = join(cwd, f);
      if (existsSync(p)) {
        parts.push(`README (first 2KB):\n${readFileSync(p, "utf8").slice(0, 2048)}`);
        break;
      }
    }
  } catch {
    /* unreadable README: skip */
  }
  try {
    const p = join(cwd, "package.json");
    if (existsSync(p)) parts.push(`package.json:\n${readFileSync(p, "utf8").slice(0, 1024)}`);
  } catch {
    /* skip */
  }
  try {
    const entries = readdirSync(cwd).filter((e) => !e.startsWith(".")).slice(0, 40);
    parts.push(`Top-level files:\n${entries.join(", ")}`);
  } catch {
    /* skip */
  }
  try {
    const proc = Bun.spawnSync(["git", "log", "--oneline", "-5"], { cwd });
    const log = proc.stdout.toString().trim();
    if (log) parts.push(`Recent commits:\n${log}`);
  } catch {
    /* not a git repo: skip */
  }
  return parts.join("\n\n");
}

async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString("utf8");
}

// One-shot fleet recommendation. NEVER hard-fails: any absence/error/parse
// failure returns null and the caller drops to the plain wizard with a note.
async function runAi(cwd: string, goal: string): Promise<InitAnswers | null> {
  const claude = Bun.which("claude");
  if (!claude) {
    console.log("note: `claude` not on PATH — using the plain wizard.");
    return null;
  }
  const prompt = buildAiPrompt(goal, gatherSignals(cwd));
  try {
    const proc = Bun.spawn([claude, "-p", "--model", "sonnet", "--output-format", "json", prompt], {
      cwd,
      stdin: "ignore", // a piped-but-open stdin makes `claude -p` wait for more input
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), AI_TIMEOUT_MS);
    const out = await readCapped(proc.stdout, AI_OUTPUT_CAP);
    await proc.exited;
    clearTimeout(timer);
    const fleet = parseAiFleet(out);
    if (!fleet) {
      console.log("note: couldn't read an AI recommendation — using the plain wizard.");
      return null;
    }
    console.log(`AI suggested a ${fleet.topology} fleet of ${fleet.seats.length} seat(s); confirm or edit each below.\n`);
    return fleet;
  } catch (e) {
    console.log(`note: AI assist failed (${(e as Error).message}) — using the plain wizard.`);
    return null;
  }
}

// --- the wizard -------------------------------------------------------------

async function runWizard(rl: Interface, cwd: string, ai: InitAnswers | null): Promise<InitAnswers> {
  const topology = await askChoice(rl, "Topology", TOPOLOGIES, ai?.topology ?? "orchestrated");
  const defaultCount = ai?.seats.length ?? (topology === "swarm" ? 3 : 4);
  const count = await askNumber(rl, "How many seats?", defaultCount, 1, 16);

  const template =
    ai !== null ? resizeTemplate(ai.seats, topology, count) : makeTemplate(topology, count);

  const seats: SeatAnswers[] = [];
  const usedNames = new Set<string>();
  for (let i = 0; i < count; i++) {
    const t = template[i]!;
    console.log(`\n— Seat ${i + 1} —`);

    // Name (unique, valid). Empty falls back to the template default, which is
    // valid + unique by construction, so re-asks only trigger on real bad input.
    let name = "";
    for (;;) {
      name = await ask(rl, "  name", t.name);
      if (!NAME_RE.test(name)) {
        console.log("  name must start alphanumeric and use only letters/digits/._- (max 64).");
        continue;
      }
      if (usedNames.has(name)) {
        console.log("  that name is already taken by another seat.");
        continue;
      }
      break;
    }
    usedNames.add(name);

    const category = await askChoice(rl, "  role type", ROLE_CATEGORIES, t.category);
    // When the user switches category, offer that category's recommendation;
    // otherwise keep the template's (possibly AI-picked) value as the default.
    const sameCat = category === t.category;
    const role = await ask(rl, "  role label", sameCat ? t.role : defaultRoleLabel(category));
    const model = await ask(rl, "  model", sameCat ? t.model : recommendModel(category));
    const backend = await askChoice(rl, "  backend", BACKENDS, sameCat ? t.backend : recommendBackend(category));
    const profile = await askChoice(rl, "  profile", PROFILES, sameCat ? t.profile : recommendProfile(category));

    seats.push({ name, role, category, model, backend, profile });
  }

  // Orchestrated/tiered fleets need exactly one orchestrator to route to; if the
  // user made none, promote seat 1 so the generated prompts stay coherent.
  if (topology !== "swarm" && !seats.some((s) => s.category === "orchestrator")) {
    const s0 = seats[0]!;
    console.log(`\nnote: no orchestrator chosen — promoting "${s0.name}" to orchestrator for a ${topology} fleet.`);
    s0.category = "orchestrator";
    if (s0.role === defaultRoleLabel("implementer")) s0.role = defaultRoleLabel("orchestrator");
  }

  return { topology, seats };
}

// --- command ----------------------------------------------------------------

export default async function init(args: string[]): Promise<number> {
  const useAi = args.includes("--ai");
  const cwd = process.cwd();
  const yamlPath = join(cwd, "patrol.yaml");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (existsSync(yamlPath)) {
      const ok = await askYesNo(rl, `patrol.yaml already exists in ${cwd}. Overwrite?`, false);
      if (!ok) {
        console.log("aborted — existing patrol.yaml left untouched.");
        return 0;
      }
    }

    let ai: InitAnswers | null = null;
    if (useAi) {
      const goal = await ask(rl, "What are you building / what's the goal for this fleet?");
      ai = await runAi(cwd, goal);
    }

    const answers = await runWizard(rl, cwd, ai);

    // Build + validate what we will actually write — never emit a file that
    // `patrol up` would reject. Re-parsing the serialized YAML also catches a
    // serializer bug, not just an invalid answer set.
    let yaml: string;
    try {
      const config = buildConfig(answers);
      yaml = serializeConfig(config, configHeader(answers.topology));
      validateConfig(parsePatrolConfig(yaml));
    } catch (e) {
      console.error(`\npatrol init: generated config is invalid — nothing written.\n  ${(e as Error).message}`);
      return 1;
    }

    writeFileSync(yamlPath, yaml);
    console.log(`\nWrote ${yamlPath} (${answers.seats.length} seat(s)).`);

    const gitignorePath = join(cwd, ".gitignore");
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : null;
    const merged = mergeGitignore(existing);
    if (merged.changed) {
      writeFileSync(gitignorePath, merged.content);
      console.log(`${existing === null ? "Created" : "Updated"} ${gitignorePath} (ignoring patrol.yaml).`);
    } else {
      console.log(".gitignore already ignores patrol.yaml.");
    }

    console.log(`\nNext steps:\n  patrol up        launch the fleet\n  patrol status    check the board`);
    return 0;
  } finally {
    rl.close();
  }
}
