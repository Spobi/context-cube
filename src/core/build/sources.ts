import { readdirSync } from "node:fs";
import { join } from "node:path";
import { exists, isDir, normalizeEol, readTextOr } from "../fsutil";
import { absPath } from "../scan";
import { cubePaths, KEPT_RECORDS_DIR } from "../paths";
import { splitLines } from "./markdown";
import { firstLines, linesAt, outline, type Candidate } from "./scan";
import type { Classified } from "./classify";
import type { RecipeSourceInput } from "../../ai/schemas/recipe";
import { estimateTokens } from "../tokens";
import { hasBlock, removeBlock } from "../index/block";

/** A source the person confirmed (plan 6.3). */
export interface ConfirmedSource {
  path: string;
  role: string;
  sections?: { startLine: number; role: string }[];
  lines: number;
  bytes: number;
}

/** The placeholder an archived source leaves in its place (see core/archive.ts). */
export const ARCHIVED_START = "<!-- context-cube:archived:start -->";
export const ARCHIVED_END = "<!-- context-cube:archived:end -->";

/** Where an archived source's original lives: context-cube/.state/archive/<path>. */
export function archivePath(root: string, path: string): string {
  return join(cubePaths(root).archive, path);
}

export function isArchived(root: string, path: string): boolean {
  return exists(archivePath(root, path));
}

/** Every archived source, as project-relative paths (not the kept records). */
export function listArchived(root: string): string[] {
  const base = cubePaths(root).archive;
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && r === KEPT_RECORDS_DIR) continue;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  if (isDir(base)) walk(base, "");
  return out.sort();
}

/**
 * A source file's own text: line endings normalized, and without the text this
 * tool adds to files (the always-loaded block, and an archive placeholder).
 * An archived source is read from the archive, so splitting, coverage, and a
 * rebuild see the same text before and after archiving.
 */
export function readSource(root: string, path: string): string {
  const snap = archivePath(root, path);
  return stripToolText(normalizeEol(readTextOr(exists(snap) ? snap : absPath(root, path), "")));
}

export function stripToolText(text: string): string {
  let out = hasBlock(text) ? removeBlock(text) : text;
  if (hasBlock(out, ARCHIVED_START, ARCHIVED_END)) out = removeBlock(out, undefined, ARCHIVED_START, ARCHIVED_END);
  return out;
}

/** True when a file in place is an archive placeholder (with or without text added since). */
export function isPlaceholder(text: string): boolean {
  return hasBlock(text, ARCHIVED_START, ARCHIVED_END);
}

/** Input for the recipe step: outline, first lines, and a few sample entries per source. */
export function recipeInput(root: string, s: ConfirmedSource, c: Candidate | undefined): RecipeSourceInput {
  const headings = c?.headings ?? [];
  const byLevel = new Map<number, number>();
  for (const h of headings) byLevel.set(h.level, (byLevel.get(h.level) ?? 0) + 1);
  const level = [...byLevel.entries()].filter(([l]) => l >= 2).sort((a, b) => b[1] - a[1])[0]?.[0];
  const entryHeads = level ? headings.filter((h) => h.level === level) : [];
  const picks = entryHeads.length > 3 ? [entryHeads[0], entryHeads[Math.floor(entryHeads.length / 2)], entryHeads[entryHeads.length - 1]] : entryHeads;
  return {
    path: s.path,
    role: s.role,
    sections: s.sections,
    lines: s.lines,
    outline: outline(headings, 250),
    firstLines: firstLines(root, s.path, 40, 3000),
    samples: picks.map((h) => linesAt(root, s.path, h.line, 8, 900)),
  };
}

export interface Estimate {
  steps: { step: string; tokens: number; note: string }[];
  total: number;
}

/**
 * Estimate (pipeline step 4): rough tokens for the remaining AI steps, before
 * any usage is spent. Every call carries a fixed overhead (plan 18).
 */
export function estimateBuild(root: string, sources: ConfirmedSource[], codeFiles: number): Estimate {
  const OVERHEAD = 4000;
  const tok = (s: ConfirmedSource) => estimateTokens(readSource(root, s.path).length);
  const byRole = (r: string) => sources.filter((s) => s.role === r || s.sections?.some((x) => x.role === r));
  // Notes are split by code; every other source gets (a share of) one recipe call.
  const structured = sources.filter((s) => s.role !== "notes");
  const recipe = structured.reduce((n, s) => n + Math.min(tok(s), 6000) + 2000, 0) + OVERHEAD * structured.length;
  const allLines = sources.reduce((n, s) => n + s.lines, 0);
  const rows = OVERHEAD + Math.ceil(allLines / 12) + codeFiles * 8 + 6000;
  const history = byRole("history").reduce((n, s) => n + tok(s), 0);
  const inv = byRole("invariants").reduce((n, s) => n + tok(s), 0);
  const notes = [...byRole("notes"), ...byRole("catalog")].reduce((n, s) => n + Math.min(tok(s), 20000), 0);
  // Entries are counted by headings; each answer carries the model's reasoning,
  // about 600 output tokens per item in practice (measured 2026-09-23).
  const count = (r: string) => byRole(r).reduce((n, s) => n + Math.max(1, Math.round(s.lines / 25)), 0);
  const enrichHistory = Math.round(history * 1.1) + OVERHEAD * Math.ceil(history / 30000 + 1) + 600 * count("history");
  const enrichInv = Math.round(inv * 1.1) + OVERHEAD * Math.ceil(inv / 30000 + 1) + 600 * count("invariants");
  const enrichNotes = Math.round(notes * 1.1) + OVERHEAD * Math.ceil(notes / 30000 + 1) + 500 * (count("notes") + count("catalog"));
  // Roots and link notes go in a few batched calls; they grow with the number of rows, not the text.
  const roots = OVERHEAD * 2 + 900 * (3 + sources.length);
  const steps = [
    { step: "recipe", tokens: recipe, note: "reads each file's outline once" },
    { step: "row structure", tokens: rows, note: "proposes the rows from headings and the code outline" },
    { step: "history summaries", tokens: enrichHistory, note: "reads each history entry once" },
    { step: "invariant labels", tokens: enrichInv, note: "reads each invariants topic once" },
    { step: "other overviews", tokens: enrichNotes, note: "reads notes and catalogs once" },
    { step: "row roots and link notes", tokens: roots, note: "short summaries per row" },
  ].filter((s) => s.tokens > OVERHEAD || s.step === "recipe" || s.step === "row structure");
  return { steps, total: steps.reduce((n, s) => n + s.tokens, 0) };
}

export function sourceLines(root: string, path: string): number {
  return splitLines(readSource(root, path)).length;
}

export function toConfirmed(c: Classified, cand: Candidate | undefined): ConfirmedSource {
  return {
    path: c.path,
    role: c.role,
    sections: c.role === "mixed" ? c.sections : undefined,
    lines: cand?.lines ?? 0,
    bytes: cand?.bytes ?? 0,
  };
}
