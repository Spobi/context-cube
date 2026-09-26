import { z } from "zod";
import { readTextOr } from "../core/fsutil";
import { absPath, listProjectFiles } from "../core/scan";
import { runStep, type RunContext, type Step } from "../ai/runner";
import prompt from "../ai/prompts/interview-rules.md";
import type { Asker } from "./ask";

/**
 * Rules for a fresh project (plan 6, 7): drafted from a short interview plus
 * project config files. The person sees the drafts and chooses.
 */

export const InterviewOut = z.object({
  rules: z.array(z.object({ text: z.string(), name: z.string() })),
  historyUnit: z.enum(["build", "release", "pr", "day", "commit", "session"]),
});
export type InterviewOutput = z.infer<typeof InterviewOut>;

export interface InterviewIn {
  answers: { question: string; answer: string }[];
  config: string;
}

export const interviewStep: Step<InterviewIn, InterviewOutput> = {
  name: "interview-rules",
  prompt,
  schema: InterviewOut,
  render: (i) =>
    [
      "## The person's answers",
      ...i.answers.map((a) => `Q: ${a.question}\nA: ${a.answer || "(no answer)"}`),
      "",
      "## From the project's config files",
      i.config || "(nothing found)",
    ].join("\n"),
};

/** Scripts and other "how this project works" facts that code can read without AI. */
export function projectFacts(root: string): string {
  const files = new Set(listProjectFiles(root));
  const out: string[] = [];
  if (files.has("package.json")) {
    try {
      const pkg = JSON.parse(readTextOr(absPath(root, "package.json"), "{}"));
      if (pkg.name) out.push(`package.json name: ${pkg.name}`);
      if (pkg.scripts) out.push(`package.json scripts: ${Object.entries(pkg.scripts).map(([k, v]) => `${k} = ${v}`).join("; ")}`);
      if (pkg.packageManager) out.push(`packageManager: ${pkg.packageManager}`);
    } catch {
      // not JSON
    }
  }
  for (const f of ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "Cargo.toml", "pyproject.toml", "go.mod", "Gemfile", "Package.swift", "Makefile", "justfile", ".github/workflows"]) {
    if ([...files].some((x) => x === f || x.startsWith(`${f}/`))) out.push(`has ${f}`);
  }
  const make = readTextOr(absPath(root, "Makefile"), "");
  const targets = [...make.matchAll(/^([a-zA-Z][\w-]*):/gm)].map((m) => m[1]).slice(0, 12);
  if (targets.length) out.push(`Makefile targets: ${targets.join(", ")}`);
  const readme = [...files].find((f) => /^readme\.md$/i.test(f));
  if (readme) out.push(`README opening:\n${readTextOr(absPath(root, readme), "").split("\n").slice(0, 25).join("\n")}`);
  return out.join("\n");
}

export const QUESTIONS = [
  "In a sentence, what is this project?",
  "Anything an AI agent must always do here? (for example: run the tests before committing)",
  "Anything it must never do? (for example: never push to main)",
];

export async function interview(root: string, ask: Asker, ctx: Omit<RunContext, "root">): Promise<InterviewOutput | undefined> {
  // Without someone to answer, skip it: no questions, no AI usage.
  if (!ask.interactive) return undefined;
  const facts = projectFacts(root);
  const answers: InterviewIn["answers"] = [];
  ask.say("\nA few quick questions to write the first rules (press Enter to skip any):");
  for (const q of QUESTIONS) answers.push({ question: q, answer: await ask.text(q, "") });
  if (!answers.some((a) => a.answer) && !facts) return undefined;
  if (!(await ask.confirm("Draft the rules from your answers with an AI step (about 6,000 tokens of your plan's usage)?", true))) return undefined;
  const r = await runStep(interviewStep, { answers, config: facts }, { ...ctx, root, label: "interview" });
  return r.output;
}
