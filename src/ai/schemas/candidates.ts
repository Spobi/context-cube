import { z } from "zod";
import type { Step } from "../runner";
import prompt from "../prompts/candidate-invariants.md";
import type { Evidence } from "../../core/build/candidates";

export const CandidatesOut = z.object({
  candidates: z.array(z.object({ name: z.string(), summary: z.string(), readWhen: z.string(), text: z.string(), evidence: z.array(z.string()) })).max(20),
});
export type CandidatesOutput = z.infer<typeof CandidatesOut>;

export const candidatesStep: Step<Evidence, CandidatesOutput> = {
  name: "candidate-invariants",
  prompt,
  schema: CandidatesOut,
  render: (e) =>
    [
      "## Reverted commits",
      ...(e.reverts.length ? e.reverts.map((x) => `- ${x}`) : ["(none)"]),
      "",
      "## Fix commits",
      ...(e.fixes.length ? e.fixes.map((x) => `- ${x}`) : ["(none)"]),
      "",
      "## Code comments",
      ...(e.comments.length ? e.comments.map((x) => `- ${x}`) : ["(none)"]),
    ].join("\n"),
};
