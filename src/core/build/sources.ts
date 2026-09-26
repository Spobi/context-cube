import { readdirSync } from "node:fs";
import { join } from "node:path";
import { exists, isDir, normalizeEol, readTextOr } from "../fsutil";
import { absPath } from "../scan";
import { cubePaths, KEPT_RECORDS_DIR } from "../paths";
import { splitLines } from "./markdown";
import { firstLines, linesAt, outline, type Candidate } from "./scan";
import type { Classified } from "./classify";
import type { RecipeSourceInput } from "../../ai/schemas/recipe";
import { estimateTokens, fmtApprox } from "../tokens";
import { hasBlock, removeBlock } from "../index/block";
import { TIER_NAME, TIER_ORDER, TIER_SIZE, tierFor, type Preset } from "../../ai/tiers";
import type { Tier } from "../../adapters/types";

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

export interface EstimateStep {
  step: string;
  tokens: number;
  note: string;
  /** The model the step runs on at this preset. */
  tier: Tier;
  /** Runs after the person reviews the rows, so it can start later on its own. */
  later: boolean;
}

export interface Estimate {
  steps: EstimateStep[];
  total: number;
}

/** One source file, or one section of a file with several kinds of content, as the estimate sees it. */
interface Part {
  role: string;
  lines: number;
  chars: number;
  /** Entries it will likely split into: headings at its most common level below the title, else about one per 25 lines. */
  entries: number;
}

function partsOf(root: string, s: ConfirmedSource, c: Candidate | undefined): Part[] {
  const lines = splitLines(readSource(root, s.path));
  const ranges = s.sections?.length
    ? [...s.sections].sort((a, b) => a.startLine - b.startLine).map((x, i, all) => ({ role: x.role, from: x.startLine, to: (all[i + 1]?.startLine ?? lines.length + 1) - 1 }))
    : [{ role: s.role, from: 1, to: lines.length }];
  return ranges.map((r) => {
    const n = Math.max(0, r.to - r.from + 1);
    const chars = lines.slice(r.from - 1, r.to).reduce((sum, l) => sum + l.length + 1, 0);
    const heads = (c?.headings ?? []).filter((h) => h.line >= r.from && h.line <= r.to && h.level >= 2);
    const byLevel = new Map<number, number>();
    for (const h of heads) byLevel.set(h.level, (byLevel.get(h.level) ?? 0) + 1);
    const top = [...byLevel.values()].sort((a, b) => b - a)[0] ?? 0;
    return { role: r.role, lines: n, chars, entries: Math.max(1, top >= 2 ? top : Math.round(n / 25)) };
  });
}

/**
 * Estimate (pipeline step 4): rough tokens for the remaining AI steps, before
 * any usage is spent. Calibrated on a real build (Quickie, 2026-09-26: ~2M
 * tokens for 20 files, 7,600 lines of history, 2,150 of invariants), where
 * most input was a fixed cost per call rather than the text: each summary call
 * carries the list of boxes it may link to, and a call that writes a lot is
 * read back a second time. Every call carries a fixed overhead (plan 18).
 */
export function estimateBuild(root: string, sources: ConfirmedSource[], codeFiles: number, preset: Preset = "balanced", candidates: Candidate[] = []): Estimate {
  const OVERHEAD = 4000;
  const on = (ai: string) => tierFor(ai, preset);
  const cand = new Map(candidates.map((c) => [c.path, c]));
  const parts = sources.flatMap((s) => partsOf(root, s, cand.get(s.path)));
  const of = (...roles: string[]) => parts.filter((p) => roles.includes(p.role));
  const sum = (ps: Part[], f: (p: Part) => number) => ps.reduce((n, p) => n + f(p), 0);
  const tok = (chars: number) => estimateTokens(chars);

  // The link targets each summary call carries: rows, the boxes about code, and (for history and notes) the invariants.
  const invEntries = sum(of("invariants"), (p) => p.entries);
  const rowsGuess = 3 + Math.min(22, 3 + Math.ceil(codeFiles / 12));
  const components = Math.min(150, Math.round(codeFiles * 0.4));
  const targets = 45 * (rowsGuess + components + invEntries);
  const targetsNoInv = 45 * (rowsGuess + components);
  /** Summary calls batch up to 12 entries or ~24,000 characters, each entry cut at `cap` characters. */
  const summaries = (ps: Part[], cap: number, readBack: number, outPerEntry: number, t: number) => {
    const n = sum(ps, (p) => p.entries);
    const chars = sum(ps, (p) => Math.min(p.chars, p.entries * cap));
    if (!n) return 0;
    const calls = Math.max(Math.ceil(chars / 24_000), Math.ceil(n / 12));
    return Math.round(calls * readBack * (3000 + t) + readBack * tok(chars) + outPerEntry * n);
  };

  // Every source with more than notes gets a recipe call; with two or more, one more call matches their cross-references.
  const structured = sources.filter((s) => s.role !== "notes");
  const recipe = structured.reduce((n, s) => n + 2 * (Math.min(tok(s.bytes), 6000) + 2000) + OVERHEAD + 3500, 0) + (structured.length >= 2 ? 28_000 : 0);
  const allLines = sum(parts, (p) => p.lines);
  const notePieces = sum(of("notes", "catalog"), (p) => p.entries);
  const rows = Math.round(1.5 * (OVERHEAD + Math.ceil(allLines / 12) + codeFiles * 8 + 6000) + 6000 + 250 * notePieces);
  const steps: EstimateStep[] = [
    { step: "recipe", tokens: recipe, note: "reads each file's outline once", tier: on("recipe"), later: false },
    { step: "row structure", tokens: rows, note: "proposes the rows from headings and the code outline, and places every note", tier: on("rows"), later: false },
    { step: "history summaries", tokens: summaries(of("history"), 8000, 2, 1250, targets), note: "reads each history entry once", tier: on("history-summaries"), later: true },
    { step: "invariant labels", tokens: summaries(of("invariants"), 9000, 1.6, 800, targetsNoInv), note: "reads each invariants topic once", tier: on("invariant-labels"), later: true },
    { step: "other overviews", tokens: summaries(of("notes", "catalog"), 6000, 1.1, 370, targets), note: "reads notes and catalogs once", tier: on("box-overviews"), later: true },
  ].filter((s) => s.tokens > 0 || s.step === "recipe" || s.step === "row structure");
  return { steps, total: steps.reduce((n, s) => n + s.tokens, 0) };
}

/** Estimated tokens per model, smallest model first, with the steps that use each. */
export function byModel(steps: EstimateStep[]): { tier: Tier; tokens: number; steps: string[] }[] {
  return TIER_ORDER.map((tier) => {
    const mine = steps.filter((s) => s.tier === tier);
    return { tier, tokens: mine.reduce((n, s) => n + s.tokens, 0), steps: mine.map((s) => s.step) };
  }).filter((m) => m.tokens > 0);
}

/** "~48,000 (Sonnet ~35,000, Opus ~13,000)" */
export function fmtByModel(steps: EstimateStep[]): string {
  const models = byModel(steps);
  const total = fmtApprox(steps.reduce((n, s) => n + s.tokens, 0));
  if (models.length === 1) return `${total} on ${TIER_NAME[models[0].tier]}`;
  return `${total} (${models.map((m) => `${TIER_NAME[m.tier]} ${fmtApprox(m.tokens)}`).join(", ")})`;
}

/** The estimate as a person reads it: the total, split by model, then by step. */
export function describeEstimate(est: Estimate): string[] {
  const models = byModel(est.steps);
  const label = (t: Tier) => `${TIER_NAME[t]} (${TIER_SIZE[t]})`;
  const lw = Math.max(...models.map((m) => label(m.tier).length));
  const nw = Math.max(...models.map((m) => fmtApprox(m.tokens).length));
  const out = [`\nThe AI steps will use roughly ${fmtApprox(est.total).slice(1)} tokens of your plan's usage (an estimate). By model:`];
  for (const m of models) out.push(`  ${label(m.tier).padEnd(lw)}  ${fmtApprox(m.tokens).padStart(nw)}  ${m.steps.join(", ")}`);
  if (models.some((m) => m.tier !== "opus")) out.push("  Smaller models use up a plan's limits more slowly than Opus, so this counts for less than the same number of Opus tokens would.");
  if (models.some((m) => m.tier === "opus")) out.push("  To use no Opus at all, answer no and run again with --preset economy (smaller models throughout).");
  out.push("By step:");
  for (const s of est.steps) out.push(`  ${s.step}: ${fmtApprox(s.tokens)} on ${TIER_NAME[s.tier]} (${s.note})`);
  return out;
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
