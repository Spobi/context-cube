import { basename, join } from "node:path";
import { z } from "zod";
import { appendLine, exists, readJson, readTextOr } from "../core/fsutil";
import { getBox, loadCube } from "../core/cube";
import { splitGenerated } from "../core/format/generated";
import { loadRecipe } from "../core/build/recipe";
import { CUBE_DIR } from "../core/paths";
import { mapLimit, runStep, StepFailed, type Step } from "../ai/runner";
import type { AIBackend } from "../ai/backends";
import prompt from "../ai/prompts/bench-judge.md";
import { loadRuns, type RunRecord } from "./run";
import { blindOrder, loadScores, type Score } from "./score";
import type { Task } from "./tasks";

/**
 * Blind scoring by a model (Phase 9), for people who'd rather not judge the
 * code themselves. Opus sees one run at a time, in shuffled order, with
 * everything that would say which copy made it taken out: edits to memory
 * files, the cube and agent settings are dropped from the diff, and box ids,
 * cube paths, memory file names, section marks and the copies' folders are
 * replaced in all text. Both copies go through the same filter, so the judge
 * sees the same kind of material from each.
 */

const Verdict = z.object({ rule: z.string(), verdict: z.enum(["yes", "no", "unclear"]), why: z.string() });
export const JudgeOutput = z.object({
  correctness: z.number().int().min(1).max(5),
  invariants: z.number().int().min(1).max(5),
  scope: z.number().int().min(1).max(5),
  rules: z.array(Verdict),
  summary: z.string(),
});
export type JudgeOut = z.infer<typeof JudgeOutput>;

export interface JudgeIn {
  task: string;
  rules: { label: string; text: string }[];
  diff: string;
  finalMessage: string;
  check?: string;
}

const MAX_DIFF = 120_000;

export function judgeStep(): Step<JudgeIn, JudgeOut> {
  return {
    name: "bench-judge",
    prompt,
    schema: JudgeOutput,
    render: (i) =>
      [
        `## task\n\n${i.task}`,
        `## rules\n\n${i.rules.length ? i.rules.map((r) => `### ${r.label}\n\n${r.text}`).join("\n\n") : "(none listed)"}`,
        `## diff\n\n\`\`\`diff\n${i.diff || "(no code changes)"}\n\`\`\``,
        `## finalMessage\n\n${i.finalMessage || "(none)"}`,
        `## check\n\n${i.check ?? "(no check for this task)"}`,
      ].join("\n\n"),
    validate: (out, input) => {
      const want = input.rules.map((r) => r.label);
      const got = out.rules.map((r) => r.rule);
      const missing = want.filter((l) => !got.includes(l));
      return missing.length ? `give a verdict for every rule; missing: ${missing.join(", ")}` : undefined;
    },
  };
}

/** Paths whose edits would say which copy made the change: the cube, agent settings, memory files. */
export function blindPaths(root: string): (path: string) => boolean {
  const memory = new Set((loadRecipe(root)?.sources ?? []).map((s) => s.path));
  return (p) =>
    p.startsWith(`${CUBE_DIR}/`) ||
    /^\.(claude|codex|agents|cursor|windsurf)\//.test(p) ||
    /(^|\/)(CLAUDE|AGENTS)\.md$/.test(p) ||
    memory.has(p);
}

/** Drops the diff sections for blind paths. */
export function filterDiff(diff: string, hide: (path: string) => boolean): string {
  const parts = diff.split(/(?=^diff --git )/m);
  return parts
    .filter((part) => {
      const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
      return !m || !(hide(m[1]) || hide(m[2]));
    })
    .join("");
}

/** Replaces what would name the copy or the memory it used. */
export function redact(text: string, root: string, prose = false): string {
  const names = [...new Set((loadRecipe(root)?.sources ?? []).map((s) => basename(s.path)))].sort((a, b) => b.length - a.length);
  let out = text
    .replace(/[^\s'"`()]*context-cube-bench\/[^/\s]+\/(?:files|cube)/g, "<repo>")
    .replace(/\bY\d{2}(?:\.X\d{3})?(?:[./]Z\d)?\b/g, "[ref]")
    .replace(/\bX\d{3}\b/g, "[ref]")
    .replace(/\bZ[0-5](?:-[a-z-]+\.md)?\b/g, "[ref]")
    .replace(/[\w./-]*context-cube\/[^\s'"`)]*/g, "[notes]")
    .replace(/§\s?\d+(?:\.\d+)*/g, "[ref]")
    .replace(/\bcontext[ -]cube\b/gi, "[notes]");
  // Words that only name the memory in an agent's prose; code can use them for other things.
  if (prose) out = out.replace(/\b(?:the )?cube\b/gi, "[notes]").replace(/\b(?:box(?:es)?|drawers?)\b/gi, "[notes]");
  for (const n of names) out = out.split(n).join("[notes]");
  return out;
}

/** The text of each rule the task lists: a box's Z1, or the free text as written. */
export function rulesFor(root: string, invariants: string[]): { id: string; label: string; text: string }[] {
  let cube: ReturnType<typeof loadCube> | undefined;
  try {
    cube = loadCube(root);
  } catch {
    cube = undefined;
  }
  return invariants.map((id, i) => {
    const box = cube ? getBox(cube, id) : undefined;
    const text = box ? splitGenerated(readTextOr(join(box.dir, "Z1-invariants.md"), "")).own.trim() : id;
    return { id, label: `Rule ${String.fromCharCode(65 + i)}`, text: redact(text || id, root) };
  });
}

export function judgeInput(root: string, run: RunRecord, task: Task): { input: JudgeIn; labels: Map<string, string> } {
  const hide = blindPaths(root);
  const wide = readTextOr(join(run.dir, "diff-wide.patch"), "");
  let diff = filterDiff(wide && wide.length <= MAX_DIFF ? wide : readTextOr(join(run.dir, "diff.patch"), ""), hide);
  if (diff.length > MAX_DIFF) diff = `${diff.slice(0, MAX_DIFF)}\n… (diff cut at ${MAX_DIFF} characters)`;
  let finalMessage = readTextOr(join(run.dir, "final-message.md"), "");
  if (!finalMessage && run.error) finalMessage = `(the run ended with an error: ${run.error})`;
  const check = exists(join(run.dir, "check.txt")) ? readTextOr(join(run.dir, "check.txt"), "").slice(-6000) : undefined;
  const rules = rulesFor(root, task.invariants);
  return {
    input: { task: task.prompt.trim(), rules: rules.map(({ label, text }) => ({ label, text })), diff: redact(diff, root), finalMessage: redact(finalMessage, root, true), check: check === undefined ? undefined : redact(check, root) },
    labels: new Map(rules.map((r) => [r.label, r.id])),
  };
}

export function unscoredRuns(dir: string): RunRecord[] {
  const meta = readJson<{ started: string }>(join(dir, "meta.json"));
  const scored = new Set(loadScores(dir).map((s) => s.run));
  return blindOrder(loadRuns(dir).filter((r) => !scored.has(r.id)), meta.started);
}

/**
 * Scores every unscored run with the judge. Each score is saved as it arrives,
 * so a usage limit keeps the finished ones and a rerun picks up the rest.
 */
export async function judgeRuns(root: string, dir: string, opts: { backend?: AIBackend; say?: (s: string) => void; parallel?: number } = {}): Promise<number> {
  const meta = readJson<{ tasks: Task[] }>(join(dir, "meta.json"));
  const todo = unscoredRuns(dir);
  let done = 0;
  await mapLimit(todo, opts.parallel ?? 2, async (run) => {
    const task = meta.tasks.find((t) => t.id === run.task)!;
    const { input, labels } = judgeInput(root, run, task);
    let r;
    try {
      r = await runStep(judgeStep(), input, { root, backend: opts.backend, label: `bench judge ${todo.indexOf(run) + 1} of ${todo.length}` });
    } catch (err) {
      // One run the judge couldn't answer for stays unscored; a rerun tries it again.
      if (!(err instanceof StepFailed)) throw err;
      opts.say?.(`  couldn't score one run: ${err.message.slice(0, 200)}`);
      return;
    }
    const respected: Record<string, "yes" | "no" | "unclear"> = {};
    const whys: string[] = [];
    for (const v of r.output.rules) {
      const id = labels.get(v.rule);
      if (!id) continue;
      respected[id] = v.verdict;
      if (v.verdict !== "yes") whys.push(`${id}: ${v.verdict}, ${v.why}`);
    }
    const s: Score = {
      run: run.id,
      correctness: r.output.correctness,
      invariants: r.output.invariants,
      scope: r.output.scope,
      respected: task.invariants.length ? respected : undefined,
      note: [r.output.summary, ...whys].join(" ").trim() || undefined,
      by: r.model ?? r.tier,
      t: new Date().toISOString(),
    };
    appendLine(join(dir, "scores.jsonl"), JSON.stringify(s));
    done++;
    opts.say?.(`  scored ${done} of ${todo.length}`);
  });
  return done;
}
