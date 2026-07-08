/**
 * costs.ts unit tests. The headline case is the subagents-dir regression: the
 * 63% undercount bug was caused by NOT globbing <proj>/<session>/subagents/*.jsonl.
 * If that glob regresses, the sonnet subagent row vanishes and total drops from
 * 0.087 to 0.06 — this test fails.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCosts, priceFor, projectDirName, findSessionIdByHeuristic } from "../src/costs.ts";
import { PRICES, DEFAULT_PRICE } from "../shared/types.ts";

const dir = mkdtempSync(join(tmpdir(), "patrol-costs-"));
const ROOT = join(dir, "projects");
const PROJ = "-tmp-projA";

function jl(obj: unknown): string {
  return JSON.stringify(obj);
}

beforeAll(() => {
  const projDir = join(ROOT, PROJ);
  const subDir = join(projDir, "sessA", "subagents");
  mkdirSync(subDir, { recursive: true });

  // flat session log
  const a = (id: string, model: string, i: number, o: number, ts: string, extra: object = {}) =>
    jl({ type: "assistant", sessionId: "sessA", timestamp: ts, message: { id, model, usage: { input_tokens: i, output_tokens: o, ...extra } } });

  writeFileSync(
    join(projDir, "sessA.jsonl"),
    [
      a("m1", "claude-opus-4-8", 1000, 2000, "2026-07-08T10:00:00Z"),
      a("m1", "claude-opus-4-8", 1000, 2000, "2026-07-08T10:00:00Z"), // resume-rewrite duplicate -> deduped
      a("m2", "claude-opus-4-8", 500, 100, "2026-07-08T10:05:00Z"),
      a("m3", "claude-opus-4-8", 9999, 9999, "2026-07-09T10:00:00Z"), // OUT of window -> excluded
      jl({ type: "user", sessionId: "sessA", timestamp: "2026-07-08T10:01:00Z", message: { id: "u1" } }), // ignored
      jl({ type: "assistant", sessionId: "sessA", timestamp: "2026-07-08T10:02:00Z", message: { id: "m4", model: "claude-opus-4-8" } }), // no usage -> ignored
      "", // blank line tolerated
    ].join("\n")
  );

  // subagent transcript — its own sessionId, lives under subagents/ (THE regression)
  writeFileSync(
    join(subDir, "agent-1.jsonl"),
    jl({ type: "assistant", sessionId: "subX", timestamp: "2026-07-08T10:10:00Z", message: { id: "s1", model: "claude-sonnet-5", usage: { input_tokens: 4000, output_tokens: 1000 } } })
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const WINDOW = { since: "2026-07-08T00:00:00Z", until: "2026-07-08T23:59:59Z" };

test("counts subagent transcripts (63%-undercount regression)", () => {
  const { rows, total_usd } = computeCosts({ projectsRoot: ROOT, ...WINDOW });
  const sonnet = rows.find((r) => r.session_id === "subX");
  expect(sonnet).toBeDefined(); // if the subagents glob regresses, this is undefined
  expect(sonnet!.model).toBe("claude-sonnet-5");
  expect(sonnet!.input).toBe(4000);
  expect(sonnet!.output).toBe(1000);
  expect(sonnet!.cost_usd).toBeCloseTo(0.027, 4); // (4000*3 + 1000*15)/1e6
  // total includes the subagent; without the subagents glob it would be 0.06
  expect(total_usd).toBeCloseTo(0.087, 4);
});

test("dedupes on (sessionId, message id) across resume rewrites", () => {
  const { rows } = computeCosts({ projectsRoot: ROOT, ...WINDOW });
  const opus = rows.find((r) => r.session_id === "sessA")!;
  expect(opus.output).toBe(2100); // m1 (2000) counted once + m2 (100), not 4100
  expect(opus.input).toBe(1500); // m1 (1000) + m2 (500)
  expect(opus.cost_usd).toBeCloseTo(0.06, 4);
});

test("excludes messages outside the time window", () => {
  const { rows } = computeCosts({ projectsRoot: ROOT, ...WINDOW });
  const opus = rows.find((r) => r.session_id === "sessA")!;
  expect(opus.input).toBe(1500); // m3 (9999, next day) excluded
});

test("attributes exact via seatSessions, else null", () => {
  const { rows } = computeCosts({
    projectsRoot: ROOT,
    ...WINDOW,
    seatSessions: new Map([["sessA", "seat1"]]),
  });
  expect(rows.find((r) => r.session_id === "sessA")!.seat_id).toBe("seat1");
  expect(rows.find((r) => r.session_id === "subX")!.seat_id).toBeNull(); // unmapped
});

test("project filter scopes unattributed rows but never drops exact-attributed ones", () => {
  const { rows } = computeCosts({
    projectsRoot: ROOT,
    ...WINDOW,
    seatSessions: new Map([["sessA", "seat1"]]),
    projects: new Set(["-some-other-project"]), // excludes PROJ
  });
  expect(rows.find((r) => r.session_id === "sessA")).toBeDefined(); // exact-attributed survives
  expect(rows.find((r) => r.session_id === "subX")).toBeUndefined(); // unattributed + out of filter -> dropped
});

test("priceFor: substring match, else default", () => {
  expect(priceFor("claude-opus-4-8")).toEqual(PRICES.opus!);
  expect(priceFor("claude-sonnet-5")).toEqual(PRICES.sonnet!);
  expect(priceFor("gpt-5.5")).toEqual(DEFAULT_PRICE);
  expect(priceFor(null)).toEqual(DEFAULT_PRICE);
});

test("projectDirName matches CC's encoding", () => {
  expect(projectDirName("/Users/me/Fable Hijack")).toBe("-Users-me-Fable-Hijack");
  expect(projectDirName("/tmp/projA")).toBe("-tmp-projA");
});

// --- session-id register-time heuristic ---

function heurFixture(cwd: string, files: Array<[name: string, ageMs: number]>, now: number): string {
  const d = mkdtempSync(join(tmpdir(), "patrol-heur-"));
  const projDir = join(d, projectDirName(cwd));
  mkdirSync(projDir, { recursive: true });
  for (const [name, ageMs] of files) {
    const f = join(projDir, name);
    writeFileSync(f, "{}");
    const sec = (now - ageMs) / 1000;
    utimesSync(f, sec, sec);
  }
  return d;
}

test("session heuristic: exactly one fresh log yields that session id", () => {
  const now = Date.now();
  const d = heurFixture("/tmp/heurA", [["sess-1111.jsonl", 5_000]], now);
  expect(findSessionIdByHeuristic({ cwd: "/tmp/heurA", projectsRoot: d, nowMs: now })).toBe("sess-1111");
  rmSync(d, { recursive: true, force: true });
});

test("session heuristic: two fresh logs yield null (ambiguous, never misattribute)", () => {
  const now = Date.now();
  const d = heurFixture("/tmp/heurB", [["sess-a.jsonl", 3_000], ["sess-b.jsonl", 4_000]], now);
  expect(findSessionIdByHeuristic({ cwd: "/tmp/heurB", projectsRoot: d, nowMs: now })).toBeNull();
  rmSync(d, { recursive: true, force: true });
});

test("session heuristic: a stale log outside the window yields null", () => {
  const now = Date.now();
  const d = heurFixture("/tmp/heurC", [["sess-old.jsonl", 300_000]], now); // 5 min old, window 120s
  expect(findSessionIdByHeuristic({ cwd: "/tmp/heurC", projectsRoot: d, nowMs: now })).toBeNull();
  rmSync(d, { recursive: true, force: true });
});
