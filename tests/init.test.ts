import { test, expect, describe } from "bun:test";
import { parsePatrolConfig } from "../src/launcher/yaml.ts";
import { validateConfig } from "../src/launcher/compose.ts";
import {
  buildConfig,
  serializeConfig,
  configHeader,
  mergeGitignore,
  parseAiFleet,
  yamlScalar,
  recommendModel,
  recommendBackend,
  recommendProfile,
  defaultRoleLabel,
  type InitAnswers,
  type RoleCategory,
  type SeatAnswers,
} from "../src/commands/init-core.ts";

function seat(category: RoleCategory, over: Partial<SeatAnswers> = {}): SeatAnswers {
  return {
    name: category,
    role: defaultRoleLabel(category),
    category,
    model: recommendModel(category),
    backend: recommendBackend(category),
    profile: recommendProfile(category),
    ...over,
  };
}

// A 1-orchestrator + 3-implementer "orchestrated" fleet — the canonical output.
const ORCHESTRATED_1_3: InitAnswers = {
  topology: "orchestrated",
  seats: [
    { name: "orchestrator", role: "lead", category: "orchestrator", model: "opus", backend: "tmux", profile: "full" },
    { name: "impl-1", role: "implementer", category: "implementer", model: "opus", backend: "tmux", profile: "full" },
    { name: "impl-2", role: "implementer", category: "implementer", model: "opus", backend: "tmux", profile: "full" },
    { name: "impl-3", role: "implementer", category: "implementer", model: "opus", backend: "tmux", profile: "full" },
  ],
};

describe("buildConfig + validate", () => {
  test("orchestrated 1+3 answers produce a config that passes validateConfig", () => {
    const config = buildConfig(ORCHESTRATED_1_3);
    expect(() => validateConfig(config)).not.toThrow();
    expect(config.seats).toHaveLength(4);
    // Every seat names a model (the hard boot guard) and defaults to tmux.
    for (const s of config.seats) {
      expect(s.model).toBeTruthy();
      expect(s.backend).toBe("tmux");
      expect(s.prompt).toBeTruthy();
    }
  });

  test("a codex bulk seat omits the (ignored) profile field", () => {
    const config = buildConfig({ topology: "tiered", seats: [seat("orchestrator"), seat("bulk")] });
    const bulk = config.seats.find((s) => s.backend === "codex")!;
    expect(bulk.model).toBe("gpt-5.6-terra");
    expect(bulk.profile).toBeUndefined();
    expect(() => validateConfig(config)).not.toThrow();
  });
});

describe("YAML round-trip", () => {
  test("serialized config re-parses to the same seats and stays valid", () => {
    const config = buildConfig(ORCHESTRATED_1_3);
    const yaml = serializeConfig(config, configHeader(ORCHESTRATED_1_3.topology));
    const reparsed = parsePatrolConfig(yaml);
    expect(() => validateConfig(reparsed)).not.toThrow();
    expect(reparsed.seats).toEqual(config.seats);
  });

  test("prompts with apostrophes + commas survive the round-trip", () => {
    // The orchestrator prompt contains "Do NOT implement" and apostrophes; the
    // implementer prompt contains commas + "don't" — both quote-sensitive.
    const config = buildConfig(ORCHESTRATED_1_3);
    const yaml = serializeConfig(config);
    const reparsed = parsePatrolConfig(yaml);
    expect(reparsed.seats[0]!.prompt).toBe(config.seats[0]!.prompt);
    expect(reparsed.seats[1]!.prompt).toBe(config.seats[1]!.prompt);
  });

  test("yamlScalar leaves bare tokens bare and quotes strings with spaces", () => {
    expect(yamlScalar("opus")).toBe("opus");
    expect(yamlScalar("gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(yamlScalar("workspace-write")).toBe("workspace-write");
    expect(yamlScalar("true")).toBe('"true"'); // reserved word must be quoted
    expect(yamlScalar("hello world")).toBe('"hello world"');
    expect(yamlScalar("it's fine")).toBe(`"it's fine"`);
  });
});

describe("per-role prompts", () => {
  test("each role category gets a distinct prompt", () => {
    const cats: RoleCategory[] = ["orchestrator", "implementer", "reviewer", "scout", "bulk"];
    const config = buildConfig({ topology: "orchestrated", seats: cats.map((c) => seat(c)) });
    const prompts = config.seats.map((s) => s.prompt!);
    expect(new Set(prompts).size).toBe(prompts.length);
  });

  test("orchestrator is told not to implement; implementer is told to worktree + test", () => {
    const config = buildConfig(ORCHESTRATED_1_3);
    expect(config.seats[0]!.prompt!.toLowerCase()).toContain("do not implement");
    const impl = config.seats[1]!.prompt!.toLowerCase();
    expect(impl).toContain("worktree");
    expect(impl).toContain("failing-case test");
  });

  test("swarm implementers coordinate with peers, not an orchestrator", () => {
    const config = buildConfig({ topology: "swarm", seats: [seat("implementer", { name: "a" }), seat("implementer", { name: "b" })] });
    expect(config.seats[0]!.prompt!.toLowerCase()).toContain("no orchestrator");
  });
});

describe("gitignore de-dupe", () => {
  test("creates the file when absent", () => {
    expect(mergeGitignore(null)).toEqual({ content: "patrol.yaml\n", changed: true });
  });

  test("appends with a newline separator when missing", () => {
    const r = mergeGitignore("node_modules\ndist\n");
    expect(r.changed).toBe(true);
    expect(r.content).toBe("node_modules\ndist\npatrol.yaml\n");
  });

  test("inserts a separator when the file lacks a trailing newline", () => {
    expect(mergeGitignore("foo").content).toBe("foo\npatrol.yaml\n");
  });

  test("no-ops when already present (exact line, no trailing newline)", () => {
    expect(mergeGitignore("patrol.yaml")).toEqual({ content: "patrol.yaml", changed: false });
    expect(mergeGitignore("a\npatrol.yaml\nb")).toEqual({ content: "a\npatrol.yaml\nb", changed: false });
  });
});

describe("AI-assist JSON parse", () => {
  const fleet = {
    topology: "orchestrated",
    seats: [
      { name: "orchestrator", role: "lead", category: "orchestrator", model: "opus", backend: "tmux", profile: "full" },
      { name: "impl-1", category: "implementer", backend: "tmux", profile: "full" }, // model omitted on purpose
    ],
  };

  test("parses the `claude -p --output-format json` envelope", () => {
    const envelope = JSON.stringify({ type: "result", result: JSON.stringify(fleet) });
    const parsed = parseAiFleet(envelope);
    expect(parsed?.topology).toBe("orchestrated");
    expect(parsed?.seats).toHaveLength(2);
    // A seat missing a model is backfilled from the category recommendation.
    expect(parsed?.seats[1]!.model).toBe("opus");
  });

  test("parses a bare JSON object embedded in prose", () => {
    const parsed = parseAiFleet(`sure, here you go:\n${JSON.stringify(fleet)}\nhope that helps!`);
    expect(parsed?.seats).toHaveLength(2);
  });

  test("returns null on unparseable / seat-less input", () => {
    expect(parseAiFleet("not json at all")).toBeNull();
    expect(parseAiFleet('{"topology":"swarm"}')).toBeNull();
  });

  test("an AI-parsed fleet builds a valid config", () => {
    const envelope = JSON.stringify({ type: "result", result: JSON.stringify(fleet) });
    const parsed = parseAiFleet(envelope)!;
    expect(() => validateConfig(buildConfig(parsed))).not.toThrow();
  });
});
