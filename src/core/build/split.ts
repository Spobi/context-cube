import { analyze, sliceLines, splitLines, type LineInfo } from "./markdown";
import { compile, normalizeKey, type Recipe, type Section, type SourceKind, type SourceRecipe } from "./recipe";
import { normalizeEol } from "../fsutil";

/**
 * Split (pipeline step 6): cuts sources into chunks by the recipe, recording
 * each chunk's source and line range. Every line of a source lands in exactly
 * one chunk, so the chunks recombine into the source exactly.
 */

export interface Chunk {
  /** Stable within a build: "<source>#L<start>". */
  id: string;
  source: string;
  section: number;
  kind: SourceKind;
  /** entry: one item (a history entry, a rule, an invariants topic). glue: text between entries. */
  role: "entry" | "glue";
  start: number;
  end: number;
  text: string;
  /** The entry's first line, without heading marks or list bullets. */
  title?: string;
  key?: string;
  date?: string;
  summary?: string;
  /** Set when an oversized entry was split into parts. */
  part?: { of: string; index: number; total: number };
}

function titleOf(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\s*#+\s*$/, "")
    .replace(/\*\*/g, "")
    .trim();
}

function matchGroup(pattern: string | undefined, line: string): string | undefined {
  if (!pattern) return undefined;
  try {
    const m = compile(pattern).exec(line);
    return m && m[1] !== undefined ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

interface Span {
  role: "entry" | "glue";
  start: number;
  end: number;
}

/** Entry and glue spans for one section, by its split mode. Lines are 1-based. */
function spans(info: LineInfo[], from: number, to: number, section: Section): Span[] {
  const out: Span[] = [];
  let cur: Span | undefined;
  const open = (role: Span["role"], line: number) => {
    if (cur) out.push(cur);
    cur = { role, start: line, end: line };
  };
  const extend = (line: number) => {
    if (!cur) cur = { role: "glue", start: line, end: line };
    else cur.end = line;
  };
  const split = section.split;
  if (split.mode === "whole") return [{ role: "entry", start: from, end: to }];
  for (let n = from; n <= to; n++) {
    const l = info[n - 1];
    if (split.mode === "heading") {
      if (l.heading && l.heading.level === split.level) open("entry", n);
      else if (l.heading && l.heading.level < split.level) open("glue", n);
      else extend(n);
    } else {
      // items: top-level list items are entries; headings and unindented paragraphs are glue.
      if (l.topItem) open("entry", n);
      else if (l.heading) open("glue", n);
      else if (cur?.role === "entry" && !l.inFence && l.text.trim() !== "" && !/^\s/.test(l.text)) open("glue", n);
      else extend(n);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Splits an oversized entry at subheadings or top-level items. Pieces smaller
 * than a third of `maxLines` join the pieces after them, so a long list of
 * short items becomes a few coherent parts, not one tiny box per item: every
 * extra box is another read for an agent that needs the whole topic.
 */
function subsplit(info: LineInfo[], span: Span, mode: "heading" | "items", level: number, maxLines: number): Span[] {
  const bounds: number[] = [];
  for (let n = span.start + 1; n <= span.end; n++) {
    const l = info[n - 1];
    if (mode === "heading" ? l.heading && l.heading.level === level + 1 : l.topItem) bounds.push(n);
  }
  if (!bounds.length) return [span];
  const pieces: Span[] = [];
  let start = span.start;
  for (const b of bounds) {
    pieces.push({ role: "entry", start, end: b - 1 });
    start = b;
  }
  pieces.push({ role: "entry", start, end: span.end });
  // A first piece that is only the heading (and blank lines) always joins the next.
  const first = pieces[0];
  if (pieces.length > 1 && info.slice(first.start, first.end).every((l) => !l.text.trim())) {
    pieces[1] = { ...pieces[1], start: first.start };
    pieces.shift();
  }
  const minLines = Math.ceil(maxLines / 3);
  const size = (p: Span) => p.end - p.start + 1;
  const parts: Span[] = [];
  let cur: Span | undefined;
  for (const p of pieces) {
    cur = cur ? { ...cur, end: p.end } : { ...p };
    if (size(cur) >= minLines) {
      parts.push(cur);
      cur = undefined;
    }
  }
  // A short tail joins the part before it.
  if (cur) {
    if (parts.length) parts[parts.length - 1].end = cur.end;
    else parts.push(cur);
  }
  return parts;
}

export function splitSource(sr: SourceRecipe, rawText: string): Chunk[] {
  const text = normalizeEol(rawText);
  const lines = splitLines(text);
  const info = analyze(text);
  const total = lines.length;
  const chunks: Chunk[] = [];
  const sections = [...sr.sections].sort((a, b) => a.startLine - b.startLine);
  if (!total) return [];
  for (let si = 0; si < sections.length; si++) {
    const section = sections[si];
    const from = si === 0 ? 1 : Math.min(section.startLine, total);
    const to = si + 1 < sections.length ? Math.min(total, sections[si + 1].startLine - 1) : total;
    if (to < from) continue;
    const level = section.split.mode === "heading" ? section.split.level : 0;
    for (const sp of spans(info, from, to, section)) {
      if (sp.role === "glue") {
        chunks.push(makeChunk(sr.path, si, section, "glue", sp.start, sp.end, lines));
        continue;
      }
      const size = sp.end - sp.start + 1;
      const parts =
        section.maxLines && size > section.maxLines && section.subsplit
          ? subsplit(info, sp, section.subsplit, section.split.mode === "heading" ? level : 0, section.maxLines)
          : [sp];
      const parent = makeChunk(sr.path, si, section, "entry", sp.start, sp.end, lines);
      parts.forEach((p, i) => {
        const c = makeChunk(sr.path, si, section, "entry", p.start, p.end, lines);
        if (parts.length > 1) {
          c.part = { of: parent.title ?? parent.id, index: i + 1, total: parts.length };
          c.key = parent.key;
          c.date = parent.date;
          if (i > 0) c.summary = undefined;
          else c.summary = parent.summary;
        }
        chunks.push(c);
      });
    }
  }
  return mergeAdjacentGlue(chunks, lines);
}

function makeChunk(source: string, section: number, s: Section, role: Chunk["role"], start: number, end: number, lines: string[]): Chunk {
  const first = lines[start - 1] ?? "";
  const c: Chunk = { id: `${source}#L${start}`, source, section, kind: s.kind, role, start, end, text: sliceLines(lines, start, end) };
  if (role === "entry") {
    c.title = titleOf(first);
    c.key = matchGroup(s.key, first);
    c.date = matchGroup(s.date, first);
    c.summary = matchGroup(s.summary, first);
  }
  return c;
}

function mergeAdjacentGlue(chunks: Chunk[], lines: string[]): Chunk[] {
  const out: Chunk[] = [];
  for (const c of chunks) {
    const last = out[out.length - 1];
    if (last && last.role === "glue" && c.role === "glue" && last.end + 1 === c.start && last.section === c.section) {
      last.end = c.end;
      last.text = sliceLines(lines, last.start, last.end);
      continue;
    }
    out.push(c);
  }
  return out;
}

export function splitAll(recipe: Recipe, read: (path: string) => string): Chunk[] {
  return recipe.sources.flatMap((sr) => splitSource(sr, read(sr.path)));
}

// ---------- coverage (pipeline step 13, before placement) ----------

export interface CoverageResult {
  source: string;
  ok: boolean;
  lines: number;
  covered: number;
  problem?: string;
}

/** Proves the chunks recombine into each source exactly (line endings normalized). */
export function chunkCoverage(chunks: Chunk[], sources: { path: string; text: string }[]): CoverageResult[] {
  return sources.map(({ path, text }) => {
    const want = normalizeEol(text);
    const mine = chunks.filter((c) => c.source === path).sort((a, b) => a.start - b.start);
    const lines = splitLines(want).length;
    let next = 1;
    for (const c of mine) {
      if (c.start !== next) return { source: path, ok: false, lines, covered: next - 1, problem: `lines ${next}–${c.start - 1} are ${c.start > next ? "missing" : "in two chunks"}` };
      next = c.end + 1;
    }
    if (next !== lines + 1) return { source: path, ok: false, lines, covered: next - 1, problem: `lines ${next}–${lines} are missing` };
    const joined = mine.map((c) => c.text).join("");
    const wantNl = want.endsWith("\n") || want === "" ? want : `${want}\n`;
    if (joined !== wantNl) return { source: path, ok: false, lines, covered: lines, problem: "recombined text differs from the source" };
    return { source: path, ok: true, lines, covered: lines };
  });
}

// ---------- cross-references ----------

/**
 * Keys to try, most exact first: the key itself; without a leading "v"
 * ("v0.2.1" → "0.2.1"); without a trailing build number in parentheses
 * ("0.2.1(1)" → "0.2.1", an entry covering the whole version); and for a
 * section-style number, its parent section ("4.3" → "4": §4.3 sits inside §4).
 * Three-part versions never fall back to fewer parts, so "1.0.6" can't turn into "1".
 */
export function keyFallbacks(key: string): string[] {
  const out = [key];
  const noV = key.replace(/^v(?=\d)/, "");
  if (noV !== key) out.push(noV);
  for (const k of [...out]) {
    const noBuild = k.replace(/\(\d+\)$/, "");
    if (noBuild !== k && noBuild) out.push(noBuild);
  }
  for (const k of [...out]) {
    const m = /^(\d+[a-z]?)\.\d+$/.exec(k);
    if (m) out.push(m[1]);
  }
  return [...new Set(out)];
}

export interface RefHit {
  chunk: string;
  text: string;
  key: string;
  kind: SourceKind;
  target?: string;
}

/** Finds legacy references (e.g. "§21", "1.0.8 (10)") and resolves them to entry chunks. */
export function findRefs(recipe: Recipe, chunks: Chunk[]): RefHit[] {
  const byKey = new Map<string, Chunk>();
  for (const c of chunks) {
    if (c.role !== "entry" || !c.key || (c.part && c.part.index > 1)) continue;
    const k = `${c.kind}:${normalizeKey(c.key)}`;
    if (!byKey.has(k)) byKey.set(k, c);
    const sk = `${c.source}|${k}`;
    if (!byKey.has(sk)) byKey.set(sk, c);
  }
  const hits: RefHit[] = [];
  for (const ref of recipe.refs) {
    let re: RegExp;
    try {
      re = compile(ref.pattern, "g");
    } catch {
      continue;
    }
    const lookup = (key: string) => {
      const k = `${ref.kind}:${key}`;
      return ref.source ? byKey.get(`${ref.source}|${k}`) : byKey.get(k);
    };
    for (const c of chunks) {
      for (const m of c.text.matchAll(re)) {
        if (m[1] === undefined) continue;
        const key = normalizeKey(m[1]);
        let target: Chunk | undefined;
        for (const candidate of keyFallbacks(key)) {
          target = lookup(candidate);
          if (target) break;
        }
        // A reference to the entry it sits in isn't a cross-reference.
        if (target && target.id === c.id) continue;
        if (target && c.part && target.start <= c.start && target.end >= c.end) continue;
        hits.push({ chunk: c.id, text: m[0], key, kind: ref.kind, target: target?.id });
      }
    }
  }
  return hits;
}
