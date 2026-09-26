import { mapLimit, runStep, type RunContext } from "../../ai/runner";
import { recipeStep, type RecipeSourceInput } from "../../ai/schemas/recipe";
import { refsStep, type RefsProblem } from "../../ai/schemas/refs";
import { batches } from "./classify";
import { codeCanWrite, codeRecipeForNotes } from "./recipeCode";
import { dryRun } from "./dryrun";
import { normalizeKey, type Recipe, type Ref, type SourceRecipe } from "./recipe";
import { recipeInput, readSource, type ConfirmedSource } from "./sources";
import type { Candidate } from "./scan";

/**
 * Writes recipe.json (pipeline step 5). Notes need no AI (code splits them);
 * structured files each get their own call, so a problem in one file only
 * retries that file; small files share a call. Then cross-reference patterns
 * are checked across all files together and fixed in one small call if many
 * don't resolve.
 */
export async function writeRecipe(
  root: string,
  sources: ConfirmedSource[],
  candidates: Candidate[],
  ctx: Omit<RunContext, "root">,
  parallel: number,
  say: (s: string) => void,
): Promise<Recipe> {
  const read = (p: string) => readSource(root, p);
  const byPath = new Map(candidates.map((c) => [c.path, c]));
  const codeSources: SourceRecipe[] = [];
  const aiInputs: RecipeSourceInput[] = [];
  for (const s of sources) {
    if (codeCanWrite(s.role)) codeSources.push(codeRecipeForNotes(s.path, read(s.path)));
    else aiInputs.push(recipeInput(root, s, byPath.get(s.path)));
  }
  const big = (i: RecipeSourceInput) => ["history", "invariants", "mixed"].includes(i.role) || i.lines > 400;
  const alone = aiInputs.filter(big).map((i) => [i]);
  const shared = batches(
    aiInputs.filter((i) => !big(i)),
    (i) => i.outline.length + i.firstLines.length + i.samples.join("").length,
    12_000,
  ).map((b) => b.slice(0, 5));
  const groups = [...alone, ...shared];
  if (groups.length) say(`Asking the AI how ${aiInputs.length} file${aiInputs.length === 1 ? " is" : "s are"} organized (${groups.length} call${groups.length === 1 ? "" : "s"}); ${codeSources.length} note file${codeSources.length === 1 ? "" : "s"} need no AI.`);
  const results = await mapLimit(groups, parallel, async (inputs) => {
    const r = await runStep(recipeStep(read), { sources: inputs }, { ...ctx, root, label: `recipe ${inputs.map((i) => i.path).join(", ")}`.slice(0, 200) });
    return r.output;
  });
  const order = new Map(sources.map((s, i) => [s.path, i]));
  const merged: Recipe = {
    version: 1,
    sources: [...codeSources, ...results.flatMap((r) => r.sources)].sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0)),
    refs: dedupeRefs(results.flatMap((r) => r.refs)),
  };
  return fixRefs(root, merged, ctx, say);
}

function dedupeRefs(refs: Ref[]): Ref[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.kind}|${r.pattern}|${r.source ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** One small call to repair reference patterns that mostly fail to resolve. */
async function fixRefs(root: string, recipe: Recipe, ctx: Omit<RunContext, "root">, say: (s: string) => void): Promise<Recipe> {
  const read = (p: string) => readSource(root, p);
  const dr = dryRun(recipe, read);
  const problems: RefsProblem[] = [];
  for (const ref of recipe.refs) {
    const re = new RegExp(ref.pattern);
    const mine = dr.refs.filter((h) => h.kind === ref.kind && re.test(h.text));
    if (mine.length < 5) continue;
    const resolved = mine.filter((h) => h.target).length;
    if (resolved / mine.length >= 0.95) continue;
    const unresolved = mine.filter((h) => !h.target).slice(0, 20);
    problems.push({
      pattern: ref.pattern,
      kind: ref.kind,
      found: mine.length,
      resolved,
      unresolved: unresolved.map((h) => {
        const chunk = dr.chunks.find((c) => c.id === h.chunk);
        const i = chunk ? chunk.text.indexOf(h.text) : -1;
        return { text: h.text, context: chunk && i >= 0 ? chunk.text.slice(Math.max(0, i - 80), i + h.text.length + 80).replace(/\n/g, " ") : "" };
      }),
      targetKeys: [...new Set(dr.chunks.filter((c) => c.kind === ref.kind && c.key).map((c) => c.key!))].slice(0, 40),
    });
  }
  if (!problems.length) return recipe;
  say(`Checking ${problems.length} cross-reference pattern${problems.length === 1 ? "" : "s"} that often didn't resolve…`);
  try {
    const r = await runStep(refsStep, { refs: recipe.refs, problems }, { ...ctx, root, label: "recipe refs" });
    const candidate: Recipe = { ...recipe, refs: r.output.refs };
    const before = dr.refRate;
    const after = dryRun(candidate, read).refRate;
    return after >= before ? candidate : recipe;
  } catch {
    return recipe;
  }
}

export { normalizeKey };
