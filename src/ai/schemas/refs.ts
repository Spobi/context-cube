import { z } from "zod";
import type { Step } from "../runner";
import prompt from "../prompts/refs.md";
import { RefSchema, regexProblem } from "../../core/build/recipe";

export interface RefsProblem {
  pattern: string;
  kind: string;
  found: number;
  resolved: number;
  unresolved: { text: string; context: string }[];
  targetKeys: string[];
}

export interface RefsIn {
  refs: z.infer<typeof RefSchema>[];
  problems: RefsProblem[];
}

export const RefsOutput = z.object({ refs: z.array(RefSchema) });
export type RefsOut = z.infer<typeof RefsOutput>;

export const refsStep: Step<RefsIn, RefsOut> = {
  name: "recipe",
  prompt,
  schema: RefsOutput,
  validate: (out) => {
    for (const r of out.refs) {
      const p = regexProblem(r.pattern);
      if (p) return p;
    }
    return undefined;
  },
};
