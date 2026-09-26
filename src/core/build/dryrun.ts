import { chunkCoverage, findRefs, splitSource, type Chunk, type RefHit } from "./split";
import { regexProblem, type Recipe } from "./recipe";
import { splitLines } from "./markdown";
import { normalizeEol } from "../fsutil";
import { fmtInt } from "../tokens";

/**
 * Checks a recipe by running it (pipeline step 5: dry-run and report). Returns
 * a problem the AI can fix, or undefined when the recipe works.
 */
export function validateRecipe(recipe: Recipe, expected: string[], read: (path: string) => string): string | undefined {
  const got = recipe.sources.map((s) => s.path);
  const missing = expected.filter((p) => !got.includes(p));
  if (missing.length) return `the recipe is missing these sources: ${missing.join(", ")}`;
  const extra = got.filter((p) => !expected.includes(p));
  if (extra.length) return `the recipe has sources that weren't given: ${extra.join(", ")}`;
  const problems: string[] = [];
  const chunks: Chunk[] = [];
  for (const sr of recipe.sources) {
    const text = read(sr.path);
    const total = splitLines(normalizeEol(text)).length;
    const sorted = [...sr.sections].sort((a, b) => a.startLine - b.startLine);
    if (sorted[0].startLine !== 1) problems.push(`${sr.path}: the first section must start at line 1`);
    for (const s of sorted) {
      if (s.startLine > total) problems.push(`${sr.path}: a section starts at line ${s.startLine}, past the end (${total} lines)`);
      for (const [name, pat] of [["key", s.key], ["date", s.date], ["summary", s.summary]] as const) {
        const p = regexProblem(pat);
        if (p) problems.push(`${sr.path} ${name}: ${p}`);
      }
    }
    if (problems.length) continue;
    const mine = splitSource(sr, text);
    chunks.push(...mine);
    sorted.forEach((s, si) => {
      const entries = mine.filter((c) => c.section === si && c.role === "entry" && (!c.part || c.part.index === 1));
      if (!entries.length) {
        problems.push(`${sr.path}: the section at line ${s.startLine} (${s.kind}) produced no entries with split ${JSON.stringify(s.split)}`);
        return;
      }
      // Some entries legitimately have no key (a history of builds can hold non-build
      // entries), so only a key regex that matches nothing is an error.
      if (s.key && entries.length >= 3 && entries.every((e) => !e.key)) {
        problems.push(
          `${sr.path}: the key regex ${JSON.stringify(s.key)} matched none of ${entries.length} entries. First lines: ${entries
            .slice(0, 4)
            .map((e) => JSON.stringify(read(sr.path).split("\n")[e.start - 1]))
            .join(", ")}`,
        );
      }
    });
    const cov = chunkCoverage(mine, [{ path: sr.path, text }]);
    if (!cov[0].ok) problems.push(`${sr.path}: coverage failed: ${cov[0].problem}`);
  }
  for (const r of recipe.refs) {
    const p = regexProblem(r.pattern);
    if (p) problems.push(`ref ${p}`);
  }
  if (problems.length) return problems.join("\n");
  const hits = findRefs(recipe, chunks);
  for (const r of recipe.refs) {
    // Only judge patterns whose targets are in this recipe; others are checked after merging.
    if (!chunks.some((c) => c.kind === r.kind && c.role === "entry")) continue;
    const mine = hits.filter((h) => h.kind === r.kind && new RegExp(r.pattern).test(h.text));
    if (mine.length < 5) continue;
    const resolved = mine.filter((h) => h.target).length;
    if (resolved / mine.length < 0.5) {
      const examples = [...new Set(mine.filter((h) => !h.target).map((h) => h.text))].slice(0, 5);
      problems.push(
        `the ref pattern ${JSON.stringify(r.pattern)} found ${mine.length} references but only ${resolved} matched a ${r.kind} entry's key. Unmatched examples: ${examples.join(", ")}. Check that group 1 captures the same text as the ${r.kind} key regex.`,
      );
    }
  }
  return problems.length ? problems.join("\n") : undefined;
}

export interface DryRun {
  chunks: Chunk[];
  refs: RefHit[];
  report: string;
  coverageOk: boolean;
  refRate: number;
}

export function dryRun(recipe: Recipe, read: (path: string) => string): DryRun {
  const chunks: Chunk[] = [];
  const lines: string[] = [];
  let coverageOk = true;
  for (const sr of recipe.sources) {
    const text = read(sr.path);
    const mine = splitSource(sr, text);
    chunks.push(...mine);
    const cov = chunkCoverage(mine, [{ path: sr.path, text }])[0];
    if (!cov.ok) coverageOk = false;
    lines.push(`${sr.path} (${fmtInt(cov.lines)} lines)${cov.ok ? "" : `: COVERAGE PROBLEM, ${cov.problem}`}`);
    const sorted = [...sr.sections].sort((a, b) => a.startLine - b.startLine);
    sorted.forEach((s, si) => {
      const entries = mine.filter((c) => c.section === si && c.role === "entry");
      const whole = entries.filter((e) => !e.part || e.part.index === 1);
      const parts = entries.filter((e) => e.part).length;
      const glue = mine.filter((c) => c.section === si && c.role === "glue").reduce((n, c) => n + c.end - c.start + 1, 0);
      const sizes = whole.map((e) => e.end - e.start + 1);
      const biggest = sizes.length ? Math.max(...sizes) : 0;
      const withKey = whole.filter((e) => e.key).length;
      const withSummary = whole.filter((e) => e.summary).length;
      const bits = [
        `${fmtInt(whole.length)} ${s.kind} entr${whole.length === 1 ? "y" : "ies"}`,
        parts ? `${parts} parts after splitting long ones` : "",
        `longest ${fmtInt(biggest)} lines`,
        s.key ? `${withKey} with a key` : "",
        s.summary ? `${withSummary} with a ready-made summary` : "",
        glue ? `${glue} lines between entries kept as-is` : "",
      ].filter(Boolean);
      lines.push(`  from line ${s.startLine}: ${bits.join(", ")}`);
      const ex = whole.slice(0, 3).map((e) => `"${(e.title ?? "").slice(0, 70)}"`);
      if (ex.length) lines.push(`    e.g. ${ex.join(", ")}`);
    });
  }
  const refs = findRefs(recipe, chunks);
  const resolved = refs.filter((r) => r.target).length;
  const refRate = refs.length ? resolved / refs.length : 1;
  if (refs.length) {
    lines.push(`Cross-references: ${fmtInt(resolved)} of ${fmtInt(refs.length)} resolve (${Math.round(refRate * 100)}%).`);
    const unresolved = [...new Set(refs.filter((r) => !r.target).map((r) => r.text))];
    if (unresolved.length) lines.push(`  Not resolved: ${unresolved.slice(0, 15).join(", ")}${unresolved.length > 15 ? `, and ${unresolved.length - 15} more` : ""}`);
  } else {
    lines.push("Cross-references: none found.");
  }
  lines.push(coverageOk ? "Coverage: every source line lands in exactly one piece." : "Coverage: FAILED (see above).");
  return { chunks, refs, report: lines.join("\n"), coverageOk, refRate };
}
