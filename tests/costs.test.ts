/**
 * costs.ts unit tests. The headline case is the subagents-dir regression: the
 * 63% undercount bug was caused by NOT globbing <proj>/<session>/subagents/*.jsonl.
 * If that glob regresses, the sonnet subagent row vanishes and total drops from
 * 0.087 to 0.06 — this test fails.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCosts, priceFor, projectDirName, findSessionIdByHeuristic, attributeSeatsToSessions, resolveTokenToSession, parseFileTail, parseUsageLine, billingSourceFromEntrypoint } from "../src/costs.ts";
import { readFileSync } from "node:fs";
import { PRICES, DEFAULT_PRICE, seatMarker } from "../shared/types.ts";

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

test("attributes exact via seatSessions; a subagent rolls up to its parent's seat", () => {
  const { rows } = computeCosts({
    projectsRoot: ROOT,
    ...WINDOW,
    seatSessions: new Map([["sessA", "seat1"]]),
  });
  expect(rows.find((r) => r.session_id === "sessA")!.seat_id).toBe("seat1");
  // subX lives under sessA/subagents/ → its spend attributes to sessA's seat,
  // while its own sonnet row stays visible (v0.2 subagent rollup)
  expect(rows.find((r) => r.session_id === "subX")!.seat_id).toBe("seat1");
});

test("unmapped sessions attribute to null", () => {
  const { rows } = computeCosts({ projectsRoot: ROOT, ...WINDOW });
  expect(rows.find((r) => r.session_id === "sessA")!.seat_id).toBeNull();
  expect(rows.find((r) => r.session_id === "subX")!.seat_id).toBeNull();
});

test("project filter scopes unattributed rows but never drops attributed ones (incl. rolled-up subagents)", () => {
  // nothing mapped → both rows unattributed; a foreign project filter drops them
  const dropped = computeCosts({
    projectsRoot: ROOT,
    ...WINDOW,
    projects: new Set(["-some-other-project"]), // excludes PROJ
  });
  expect(dropped.rows.find((r) => r.session_id === "sessA")).toBeUndefined();
  expect(dropped.rows.find((r) => r.session_id === "subX")).toBeUndefined();

  // sessA mapped → sessA AND its subagent subX (rolled up to sessA) both survive
  const kept = computeCosts({
    projectsRoot: ROOT,
    ...WINDOW,
    seatSessions: new Map([["sessA", "seat1"]]),
    projects: new Set(["-some-other-project"]),
  });
  expect(kept.rows.find((r) => r.session_id === "sessA")).toBeDefined();
  expect(kept.rows.find((r) => r.session_id === "subX")).toBeDefined();
});

test("billing_source: entrypoint maps to the wallet (real claude -p fixture)", () => {
  // Drives off a fixture of REAL claude -p records: an sdk-cli assistant (Agent-SDK
  // wallet) and a cli assistant (interactive subscription). See CONTEXT-5 lesson —
  // the entrypoint field and usage shape are exactly what `claude -p` emits.
  const fx = join(dir, "projects-fx");
  const p = join(fx, "-tmp-fx");
  mkdirSync(p, { recursive: true });
  const real = readFileSync(join(import.meta.dir, "fixtures", "billing-source.jsonl"), "utf8").trim().split("\n");
  writeFileSync(join(p, "real-sdk-sess.jsonl"), real[0]!);
  writeFileSync(join(p, "real-cli-sess.jsonl"), real[1]!);

  const { rows, by_source } = computeCosts({ projectsRoot: fx, since: "2026-07-22T00:00:00Z", until: "2026-07-22T23:59:59Z" });
  const sdk = rows.find((r) => r.session_id === "real-sdk-sess")!;
  const cli = rows.find((r) => r.session_id === "real-cli-sess")!;
  expect(sdk.billing_source).toBe("agent-sdk"); // sdk-cli
  expect(cli.billing_source).toBe("subscription"); // cli

  // by_source keeps the wallets separate — never summed into one number.
  expect(by_source).toBeDefined();
  expect(by_source!["agent-sdk"]).toBeCloseTo(sdk.cost_usd, 4);
  expect(by_source!["subscription"]).toBeCloseTo(cli.cost_usd, 4);
  expect(by_source!.external).toBeUndefined(); // no codex transcript in this fixture
});

test("billingSourceFromEntrypoint: sdk* => agent-sdk, else subscription; never external", () => {
  expect(billingSourceFromEntrypoint("sdk-cli")).toBe("agent-sdk");
  expect(billingSourceFromEntrypoint("sdk-py")).toBe("agent-sdk");
  expect(billingSourceFromEntrypoint("cli")).toBe("subscription");
  expect(billingSourceFromEntrypoint(null)).toBe("subscription");
  expect(billingSourceFromEntrypoint(undefined)).toBe("subscription");
  // "external" is codex-only (no transcript), derived from backend — never from entrypoint.
  expect(billingSourceFromEntrypoint("anything-else")).toBe("subscription");
});

test("parseUsageLine surfaces the top-level entrypoint field", () => {
  const withEp = parseUsageLine(JSON.stringify({ type: "assistant", sessionId: "s", entrypoint: "sdk-py", message: { id: "m", model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 2 } } }));
  expect(withEp!.entrypoint).toBe("sdk-py");
  const noEp = parseUsageLine(JSON.stringify({ type: "assistant", sessionId: "s", message: { id: "m2", model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 2 } } }));
  expect(noEp!.entrypoint).toBeNull();
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

// --- query-time attribution (register-time race fix) ---

function attrLog(d: string, cwd: string, file: string, tsMs: number) {
  const pd = join(d, projectDirName(cwd));
  mkdirSync(pd, { recursive: true });
  writeFileSync(
    join(pd, file),
    JSON.stringify({ type: "assistant", sessionId: file.replace(".jsonl", ""), timestamp: new Date(tsMs).toISOString(), message: { id: "x" } })
  );
}

test("attributeSeatsToSessions: matches by start-time, honors fast path, skips stale", () => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const d = mkdtempSync(join(tmpdir(), "patrol-attr-"));
  attrLog(d, "/tmp/attrA", "sA.jsonl", now); // first ts ~= registered_at -> matches
  attrLog(d, "/tmp/attrB", "sB.jsonl", now - 10 * 60_000); // 10 min off -> outside window

  const map = attributeSeatsToSessions({
    projectsRoot: d,
    seats: [
      { id: "seatA", cwd: "/tmp/attrA", session_id: null, registered_at: nowIso },
      { id: "seatB", cwd: "/tmp/attrB", session_id: null, registered_at: nowIso },
      { id: "seatC", cwd: "/whatever", session_id: "explicit", registered_at: nowIso }, // register-time fast path
    ],
  });
  expect(map.get("sA")).toBe("seatA");
  expect(map.has("sB")).toBe(false);
  expect(map.get("explicit")).toBe("seatC");
  rmSync(d, { recursive: true, force: true });
});

test("attributeSeatsToSessions: a session two seats both match is dropped (cross-seat unique)", () => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const d = mkdtempSync(join(tmpdir(), "patrol-attr2-"));
  attrLog(d, "/tmp/shared", "shared.jsonl", now);

  const map = attributeSeatsToSessions({
    projectsRoot: d,
    seats: [
      { id: "s1", cwd: "/tmp/shared", session_id: null, registered_at: nowIso },
      { id: "s2", cwd: "/tmp/shared", session_id: null, registered_at: nowIso },
    ],
  });
  expect(map.has("shared")).toBe(false); // claimed by 2 seats -> unattributed, never misattributed
  rmSync(d, { recursive: true, force: true });
});

// --- Layer 1: token -> session resolution (the same-cwd fix) ---

function tokenFixture(cwd: string, files: Array<[name: string, contains: string]>): string {
  const d = mkdtempSync(join(tmpdir(), "patrol-tok-"));
  const projDir = join(d, projectDirName(cwd));
  mkdirSync(projDir, { recursive: true });
  for (const [name, contains] of files) {
    writeFileSync(join(projDir, name), jl({ type: "user", message: { role: "user", content: contains } }) + "\n");
  }
  return d;
}

test("resolveTokenToSession: two same-cwd logs, distinct tokens, each resolves exactly (never swapped)", () => {
  const t1 = "cp-0375a012";
  const t2 = "cp-deadbeef";
  const d = tokenFixture("/tmp/samecwd", [
    ["sess-1111.jsonl", `hi ${seatMarker(t1)} go`],
    ["sess-2222.jsonl", `yo ${seatMarker(t2)} run`],
  ]);
  expect(resolveTokenToSession({ cwd: "/tmp/samecwd", projectsRoot: d, token: t1 })).toBe("sess-1111");
  expect(resolveTokenToSession({ cwd: "/tmp/samecwd", projectsRoot: d, token: t2 })).toBe("sess-2222");
  rmSync(d, { recursive: true, force: true });
});

test("resolveTokenToSession: token in neither file -> null (not written yet)", () => {
  const d = tokenFixture("/tmp/none", [["a.jsonl", "no marker here"], ["b.jsonl", "nor here"]]);
  expect(resolveTokenToSession({ cwd: "/tmp/none", projectsRoot: d, token: "cp-00000000" })).toBeNull();
  rmSync(d, { recursive: true, force: true });
});

test("resolveTokenToSession: token in more than one file -> null (ambiguous, never guess)", () => {
  const t = "cp-abcabc12";
  const d = tokenFixture("/tmp/dup", [["a.jsonl", seatMarker(t)], ["b.jsonl", seatMarker(t)]]);
  expect(resolveTokenToSession({ cwd: "/tmp/dup", projectsRoot: d, token: t })).toBeNull();
  rmSync(d, { recursive: true, force: true });
});

// --- Layer 1 scan cache: an unchanged file must not be re-read every tick ---

test("resolveTokenToSession: an unchanged (size,mtime) file is skipped on re-scan", () => {
  const t = "cp-5555aaaa";
  const marker = seatMarker(t);
  const filler = "x".repeat(marker.length); // same byte length as the marker
  const line = (mid: string) => jl({ type: "user", message: { role: "user", content: `pre ${mid} post` } }) + "\n";
  const d = mkdtempSync(join(tmpdir(), "patrol-tokcache-"));
  const projDir = join(d, projectDirName("/tmp/cache1"));
  mkdirSync(projDir, { recursive: true });
  const f = join(projDir, "sess-c.jsonl");

  // Whole-second mtime so the (size,mtime) guard compares exact integers (no
  // float round-trip from utimes).
  const fixedSec = Math.floor(Date.now() / 1000) - 100;
  writeFileSync(f, line(filler)); // NO marker
  utimesSync(f, fixedSec, fixedSec);
  const st = statSync(f);

  const cache = new Map<string, { size: number; mtimeMs: number }>();
  expect(resolveTokenToSession({ cwd: "/tmp/cache1", projectsRoot: d, token: t }, cache)).toBeNull();
  expect(cache.has(f)).toBe(true); // miss recorded

  // Rewrite to CONTAIN the marker at the SAME byte length, and restore the same
  // whole-second mtime → (size,mtime) unchanged. A cache-aware scan must SKIP it,
  // so the now-present marker is NOT seen (proves the file was not re-read).
  writeFileSync(f, line(marker));
  utimesSync(f, fixedSec, fixedSec);
  expect(statSync(f).size).toBe(st.size);
  expect(statSync(f).mtimeMs).toBe(st.mtimeMs);
  expect(resolveTokenToSession({ cwd: "/tmp/cache1", projectsRoot: d, token: t }, cache)).toBeNull();

  // A cold cache re-reads and finds it — proves the file genuinely matches and the
  // earlier null was the skip, not a bad fixture.
  expect(resolveTokenToSession({ cwd: "/tmp/cache1", projectsRoot: d, token: t }, new Map())).toBe("sess-c");
  rmSync(d, { recursive: true, force: true });
});

test("resolveTokenToSession: a newly appearing file is scanned and binds even with a warm cache", () => {
  const t = "cp-6666bbbb";
  const d = mkdtempSync(join(tmpdir(), "patrol-toknew-"));
  const projDir = join(d, projectDirName("/tmp/cache2"));
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, "decoy.jsonl"), jl({ type: "user", message: { role: "user", content: "no marker" } }) + "\n");

  const cache = new Map<string, { size: number; mtimeMs: number }>();
  expect(resolveTokenToSession({ cwd: "/tmp/cache2", projectsRoot: d, token: t }, cache)).toBeNull(); // decoy cached as a miss

  // The seat's real log appears later; the warm cache must not hide the new file.
  writeFileSync(join(projDir, "sess-new.jsonl"), jl({ type: "user", message: { role: "user", content: `go ${seatMarker(t)}` } }) + "\n");
  expect(resolveTokenToSession({ cwd: "/tmp/cache2", projectsRoot: d, token: t }, cache)).toBe("sess-new");
  rmSync(d, { recursive: true, force: true });
});

// --- incremental single-file parser (byte cursor) ---

test("parseFileTail: resumes from the cursor so only appended records land", () => {
  const d = mkdtempSync(join(tmpdir(), "patrol-tail-"));
  const f = join(d, "s.jsonl");
  const rec = (id: string, i: number) =>
    jl({ type: "assistant", sessionId: "s", timestamp: "2026-07-08T10:00:00Z", message: { id, model: "claude-opus-4-8", usage: { input_tokens: i, output_tokens: 0 } } }) + "\n";

  writeFileSync(f, rec("m1", 100) + rec("m2", 200));
  const first = parseFileTail(f, 0);
  expect(first.records.map((r) => r.msgId)).toEqual(["m1", "m2"]);
  expect(first.bytesParsed).toBe(first.size); // consumed to EOF (trailing newline)

  // append a third record; parsing from the saved cursor yields ONLY the delta
  writeFileSync(f, rec("m1", 100) + rec("m2", 200) + rec("m3", 300));
  const second = parseFileTail(f, first.bytesParsed);
  expect(second.records.map((r) => r.msgId)).toEqual(["m3"]);
  expect(second.bytesParsed).toBe(second.size);
  rmSync(d, { recursive: true, force: true });
});

test("parseFileTail: a partial final line (mid-write) is not consumed until it completes", () => {
  const d = mkdtempSync(join(tmpdir(), "patrol-tail2-"));
  const f = join(d, "s.jsonl");
  const full = jl({ type: "assistant", sessionId: "s", timestamp: "2026-07-08T10:00:00Z", message: { id: "m1", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 0 } } }) + "\n";
  writeFileSync(f, full + '{"type":"assistant","partial'); // no trailing newline on line 2
  const r = parseFileTail(f, 0);
  expect(r.records.map((x) => x.msgId)).toEqual(["m1"]); // only the complete line
  expect(r.bytesParsed).toBe(Buffer.byteLength(full)); // cursor stops at the last newline
  rmSync(d, { recursive: true, force: true });
});

// --- v0.2.3 F4: the tail parser must be BOUNDED ---------------------------------
// parseFileTail runs synchronously inside the broker on every index tick. v0.2.2 allocated
// the entire unseen tail in one Buffer, so a large transcript stalled all broker HTTP and
// heartbeats behind one giant allocation. These pin the bounded behaviour.

function usageLine(id: string, input: number): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: "chunkS",
    timestamp: "2026-07-14T10:00:00Z",
    message: { id, model: "claude-opus-4-8", usage: { input_tokens: input, output_tokens: 1 } },
  });
}

test("tail parses across chunk boundaries: records split by a chunk are not lost or doubled", () => {
  const d = mkdtempSync(join(tmpdir(), "patrol-tail-"));
  const f = join(d, "big.jsonl");
  const N = 200;
  writeFileSync(f, Array.from({ length: N }, (_, i) => usageLine(`m${i}`, i + 1)).join("\n") + "\n");

  // A chunk far smaller than a single record forces lines to straddle chunk reads, which is
  // exactly where a partial-line bug shows up. The whole-file read could never hit this.
  const tiny = parseFileTail(f, 0, { chunkBytes: 7 });
  expect(tiny.records).toHaveLength(N);
  expect(tiny.records.map((r) => r.input)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  expect(tiny.bytesParsed).toBe(statSync(f).size);

  // Identical result to the default (1 MiB) path: chunking must not change semantics.
  const dflt = parseFileTail(f, 0);
  expect(tiny.records).toEqual(dflt.records);
  expect(tiny.bytesParsed).toBe(dflt.bytesParsed);
  rmSync(d, { recursive: true, force: true });
});

test("tail size-guard: an oversize record is skipped and the cursor still advances", () => {
  const d = mkdtempSync(join(tmpdir(), "patrol-tail-cap-"));
  const f = join(d, "fat.jsonl");
  // A single absurd line between two good ones. It is a VALID, parseable usage record on
  // purpose — otherwise it would be dropped for being unparseable and the test would pass
  // whether or not a cap exists. Only the size guard can reject this one.
  const fat = JSON.stringify({
    type: "assistant",
    sessionId: "chunkS",
    timestamp: "2026-07-14T10:00:00Z",
    junk: "x".repeat(5000),
    message: { id: "FAT", model: "claude-opus-4-8", usage: { input_tokens: 999, output_tokens: 1 } },
  });
  writeFileSync(f, [usageLine("good1", 10), fat, usageLine("good2", 20)].join("\n") + "\n");

  // Sanity: without the guard this line DOES parse to a record, so the assertion below is
  // pinning the cap and nothing else.
  expect(parseFileTail(f, 0).records.map((r) => r.msgId)).toEqual(["good1", "FAT", "good2"]);

  const out = parseFileTail(f, 0, { chunkBytes: 64, maxRecordBytes: 500 });
  // The two real records survive; the oversize one is dropped, not fatal.
  expect(out.records.map((r) => r.msgId)).toEqual(["good1", "good2"]);
  // Cursor reached EOF: the fat line was consumed, so the next tick does not re-read it.
  expect(out.bytesParsed).toBe(statSync(f).size);
  rmSync(d, { recursive: true, force: true });
});

test("tail keeps the incremental-cursor contract: a torn trailing write is not consumed", () => {
  const d = mkdtempSync(join(tmpdir(), "patrol-tail-torn-"));
  const f = join(d, "torn.jsonl");
  // Complete line, then a half-written one with no newline (a live append caught mid-write).
  writeFileSync(f, usageLine("done", 5) + "\n" + '{"type":"assistant","half');

  const out = parseFileTail(f, 0, { chunkBytes: 8 });
  expect(out.records.map((r) => r.msgId)).toEqual(["done"]);
  // bytesParsed stops just past the LAST NEWLINE, so the torn tail is re-read next tick.
  expect(out.bytesParsed).toBeLessThan(statSync(f).size);
  expect(out.bytesParsed).toBe(usageLine("done", 5).length + 1);
  rmSync(d, { recursive: true, force: true });
});
