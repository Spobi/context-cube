import { z } from "zod";
import type { Step } from "../runner";
import historyPrompt from "../prompts/history-summaries.md";
import invariantsPrompt from "../prompts/invariant-labels.md";
import overviewsPrompt from "../prompts/box-overviews.md";

export interface Target {
  id: string;
  line: string;
}

export interface EnrichItem {
  id: string;
  title: string;
  text: string;
  /** A ready-made summary from the recipe, if any. */
  summary?: string;
}

export interface EnrichIn {
  targets: Target[];
  items: EnrichItem[];
}

const TargetLink = z.object({ to: z.string(), note: z.string() });

export const HistoryOut = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      summary: z.string(),
      readWhen: z.string(),
      touches: z.array(TargetLink),
      projectWide: z.boolean(),
    }),
  ),
});

export const InvariantsOut = z.object({
  topics: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      label: z.string(),
      scope: z.string(),
      readWhen: z.string(),
      governs: z.array(TargetLink),
    }),
  ),
});

export const OverviewsOut = z.object({
  pieces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      summary: z.string(),
      readWhen: z.string(),
      links: z.array(z.object({ to: z.string(), rel: z.enum(["implements", "see-also"]), note: z.string() })).optional(),
    }),
  ),
});

function render(input: EnrichIn, label: string): string {
  const parts = ["## Targets (link only to these ids)", ...input.targets.map((t) => `- ${t.line}`), "", `## ${label}`];
  for (const it of input.items) {
    parts.push("", `### ${it.id}: ${it.title}`);
    if (it.summary) parts.push(`Ready-made summary: ${it.summary}`);
    parts.push("```text", it.text.replace(/```/g, "ˋˋˋ"), "```");
  }
  return parts.join("\n");
}

function checkIds(got: string[], input: EnrichIn): string | undefined {
  const want = input.items.map((i) => i.id);
  const missing = want.filter((id) => !got.includes(id));
  if (missing.length) return `missing ids: ${missing.join(", ")}`;
  return undefined;
}


// Only missing entries fail validation (the whole answer is retried then). Unknown
// target ids are dropped by the caller instead, so one bad link doesn't cost a retry.

export const historyStep: Step<EnrichIn, z.infer<typeof HistoryOut>> = {
  name: "history-summaries",
  prompt: historyPrompt,
  schema: HistoryOut,
  render: (i) => render(i, "History entries"),
  validate: (out, input) => checkIds(out.entries.map((e) => e.id), input),
};

export const invariantsStep: Step<EnrichIn, z.infer<typeof InvariantsOut>> = {
  name: "invariant-labels",
  prompt: invariantsPrompt,
  schema: InvariantsOut,
  render: (i) => render(i, "Invariants topics"),
  validate: (out, input) => checkIds(out.topics.map((t) => t.id), input),
};

export const overviewsStep: Step<EnrichIn, z.infer<typeof OverviewsOut>> = {
  name: "box-overviews",
  prompt: overviewsPrompt,
  schema: OverviewsOut,
  render: (i) => render(i, "Pieces"),
  validate: (out, input) => checkIds(out.pieces.map((p) => p.id), input),
};
