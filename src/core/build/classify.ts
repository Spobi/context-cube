import { runStep, mapLimit, type RunContext } from "../../ai/runner";
import { classifyStep, type ClassifyFileInput, type FileClass } from "../../ai/schemas/classify";
import { tierAbove, tierFor } from "../../ai/tiers";
import { firstLines, outline, type Candidate } from "./scan";

/**
 * Classify (pipeline step 2): decide what role each candidate plays, per
 * section for mixed files. Several files go in each call so the fixed cost of
 * a call is shared. Files the cheap tier is unsure about get a second look one
 * tier up (balanced preset: haiku, unclear → sonnet).
 */

export interface Classified extends FileClass {
  tier: string;
}

const BATCH_CHARS = 14_000;

function toInput(root: string, c: Candidate): ClassifyFileInput {
  return {
    path: c.path,
    lines: c.lines,
    bytes: c.bytes,
    hints: c.hints,
    outline: outline(c.headings, 50),
    firstLines: firstLines(root, c.path, 30, 1800),
  };
}

export function batches<T>(items: T[], size: (t: T) => number, budget: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let used = 0;
  for (const it of items) {
    const s = size(it);
    if (cur.length && used + s > budget) {
      out.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(it);
    used += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

export async function classifyCandidates(root: string, candidates: Candidate[], ctx: Omit<RunContext, "root">, parallel = 4): Promise<Classified[]> {
  const inputs = candidates.map((c) => toInput(root, c));
  const size = (f: ClassifyFileInput) => f.outline.length + f.firstLines.length + 300;
  const groups = batches(inputs, size, BATCH_CHARS);
  const preset = ctx.preset ?? "balanced";
  const firstTier = ctx.tier ?? tierFor("classify", preset);
  const results = await mapLimit(groups, parallel, async (files) => {
    const r = await runStep(classifyStep, { files }, { ...ctx, root, tier: firstTier, label: `classify ${files.length} files` });
    return r.output.files.map((f) => ({ ...f, tier: r.tier }));
  });
  const all = results.flat();
  // Unclear files get a second look one tier up (not in the economy preset).
  const unclear = all.filter((f) => f.confidence === "low");
  if (unclear.length && preset !== "economy") {
    const up = tierAbove(firstTier);
    const again = inputs.filter((i) => unclear.some((u) => u.path === i.path));
    const second = await mapLimit(batches(again, size, BATCH_CHARS), parallel, async (files) => {
      const r = await runStep(classifyStep, { files }, { ...ctx, root, tier: up, label: `classify (second look) ${files.length} files` });
      return r.output.files.map((f) => ({ ...f, tier: r.tier }));
    });
    for (const f of second.flat()) {
      const i = all.findIndex((x) => x.path === f.path);
      if (i >= 0) all[i] = f;
    }
  }
  return all;
}

/** Plain-language line for the confirm step (plan 6.3). */
export function describeClass(c: Classified): string {
  const role: Record<string, string> = {
    rules: "standing instructions (rules)",
    history: "a history of changes",
    invariants: "rules that must never be broken (invariants)",
    catalog: "a catalog of like items",
    notes: "notes worth keeping (designs, plans, decisions)",
    other: "not project memory",
    mixed: "a mix",
  };
  const sections = c.role === "mixed" && c.sections ? ` (${c.sections.map((s) => `from line ${s.startLine}: ${s.role}`).join("; ")})` : "";
  return `${c.path} looks like ${role[c.role] ?? c.role}${sections}. ${c.why}${c.confidence === "low" ? " (not sure)" : ""}`;
}

/** Rough tokens for classifying these candidates, before asking to spend them. */
export function classifyEstimate(root: string, candidates: Candidate[]): number {
  const inputs = candidates.map((c) => toInput(root, c));
  const size = (f: ClassifyFileInput) => f.outline.length + f.firstLines.length + 300;
  const calls = batches(inputs, size, BATCH_CHARS).length;
  return Math.ceil(inputs.reduce((n, f) => n + size(f), 0) / 4) + calls * 4000 + candidates.length * 150;
}
