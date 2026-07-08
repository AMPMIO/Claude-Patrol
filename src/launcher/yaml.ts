// Minimal indentation YAML parser — the subset patrol.yaml needs.
//
// ponytail: handles block maps, block sequences, inline flow lists/maps
// ([a,b] / {k: v}), and bare/single/double-quoted scalars with true/false/int
// coercion. It does NOT handle anchors, block scalars (| >), multiple docs,
// tags, or multiline flow. That is deliberate — patrol.yaml is a small flat-ish
// config. If it ever grows those features, escalate to a real YAML lib rather
// than extending this (the CONTRACTS.md dependency rule allows that escalation).
//
// Bun.YAML is absent in Bun 1.2.20 (checked), hence this parser rather than a dep.

import type { PatrolConfig } from "../../shared/types.ts";

type Line = { indent: number; text: string };

function scalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "") return "";
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

// Split "a, b, {x: 1}" respecting [] {} '' "" nesting — used for inline flow.
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = "", cur = "";
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch; cur += ch;
    } else if (ch === "[" || ch === "{") {
      depth++; cur += ch;
    } else if (ch === "]" || ch === "}") {
      depth--; cur += ch;
    } else if (ch === "," && depth === 0) {
      out.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

function parseFlow(s: string): unknown {
  const t = s.trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (inner === "") return [];
    return splitTopLevel(inner).map((e) => parseValue(e.trim()));
  }
  if (t.startsWith("{") && t.endsWith("}")) {
    const inner = t.slice(1, -1).trim();
    const obj: Record<string, unknown> = {};
    if (inner === "") return obj;
    for (const pair of splitTopLevel(inner)) {
      const colon = pair.indexOf(":");
      if (colon === -1) throw new Error(`bad inline map entry: ${pair.trim()}`);
      obj[pair.slice(0, colon).trim()] = parseValue(pair.slice(colon + 1).trim());
    }
    return obj;
  }
  return scalar(t);
}

function parseValue(s: string): unknown {
  const t = s.trim();
  if (t.startsWith("[") || t.startsWith("{")) return parseFlow(t);
  return scalar(t);
}

// Strip a trailing comment not inside quotes.
function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

function tokenize(src: string): Line[] {
  const out: Line[] = [];
  for (const rawLine of src.split("\n")) {
    const noComment = stripComment(rawLine);
    if (noComment.trim() === "") continue;
    const indent = noComment.length - noComment.trimStart().length;
    out.push({ indent, text: noComment.trim() });
  }
  return out;
}

// Parse the block at lines[i] whose members share `indent`. Returns [value, next].
function parseBlock(lines: Line[], i: number, indent: number): [unknown, number] {
  const first = lines[i]!;
  if (first.text.startsWith("- ") || first.text === "-") {
    return parseSeq(lines, i, indent);
  }
  return parseMap(lines, i, indent);
}

function parseSeq(lines: Line[], i: number, indent: number): [unknown[], number] {
  const out: unknown[] = [];
  while (i < lines.length && lines[i]!.indent === indent && lines[i]!.text.startsWith("-")) {
    const line = lines[i]!;
    const rest = line.text === "-" ? "" : line.text.slice(2);
    if (rest === "") {
      // nested block starts on following lines
      const next = lines[i + 1];
      if (next && next.indent > indent) {
        const [val, ni] = parseBlock(lines, i + 1, next.indent);
        out.push(val); i = ni;
      } else {
        out.push(null); i++;
      }
    } else if (/^[^:\s]+:(\s|$)/.test(rest) || rest.includes(": ")) {
      // "- key: value" — a map item whose first key sits on the dash line.
      // Re-tokenize this item as a map by treating the dash content as the
      // first entry at a virtual indent, plus any deeper following lines.
      const itemIndent = indent + 2;
      const synthetic: Line[] = [{ indent: itemIndent, text: rest }];
      let j = i + 1;
      while (j < lines.length && lines[j]!.indent >= itemIndent) {
        synthetic.push(lines[j]!); j++;
      }
      const [val] = parseMap(synthetic, 0, itemIndent);
      out.push(val); i = j;
    } else {
      out.push(parseValue(rest)); i++;
    }
  }
  return [out, i];
}

function parseMap(lines: Line[], i: number, indent: number): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  while (i < lines.length && lines[i]!.indent === indent && !lines[i]!.text.startsWith("- ")) {
    const line = lines[i]!;
    const colon = line.text.indexOf(":");
    if (colon === -1) throw new Error(`expected "key: value" but got: ${line.text}`);
    const key = line.text.slice(0, colon).trim();
    const rhs = line.text.slice(colon + 1).trim();
    if (rhs !== "") {
      out[key] = parseValue(rhs); i++;
    } else {
      const next = lines[i + 1];
      if (next && next.indent > indent) {
        const [val, ni] = parseBlock(lines, i + 1, next.indent);
        out[key] = val; i = ni;
      } else {
        out[key] = null; i++;
      }
    }
  }
  return [out, i];
}

export function parseYaml(src: string): unknown {
  const lines = tokenize(src);
  if (lines.length === 0) return null;
  const [val] = parseBlock(lines, 0, lines[0]!.indent);
  return val;
}

// Parse + shape-check into PatrolConfig. Shape errors here are config-author
// mistakes, so they carry the offending value.
export function parsePatrolConfig(src: string): PatrolConfig {
  const doc = parseYaml(src);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("patrol.yaml must be a mapping with a top-level `seats:` list");
  }
  const seats = (doc as Record<string, unknown>).seats;
  if (!Array.isArray(seats)) {
    throw new Error("patrol.yaml `seats:` must be a list");
  }
  return { seats: seats as PatrolConfig["seats"] };
}
