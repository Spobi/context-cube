import { z } from "zod";
import type { Step } from "../runner";
import prompt from "../prompts/classify.md";

export const ROLES = ["rules", "history", "invariants", "catalog", "notes", "other"] as const;

export const ClassifyOutput = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      role: z.enum([...ROLES, "mixed"]),
      confidence: z.enum(["high", "low"]),
      why: z.string(),
      sections: z.array(z.object({ startLine: z.number().int().min(1), role: z.enum(ROLES) })).optional(),
    }),
  ),
});
export type ClassifyOut = z.infer<typeof ClassifyOutput>;
export type FileClass = ClassifyOut["files"][number];

export interface ClassifyFileInput {
  path: string;
  lines: number;
  bytes: number;
  hints: Record<string, unknown>;
  outline: string;
  firstLines: string;
}

export interface ClassifyIn {
  files: ClassifyFileInput[];
}

export const classifyStep: Step<ClassifyIn, ClassifyOut> = {
  name: "classify",
  prompt,
  schema: ClassifyOutput,
  render: (input) =>
    input.files
      .map(
        (f) =>
          `## File: ${f.path}\n${f.lines} lines, ${f.bytes} bytes. Hints: ${JSON.stringify(f.hints)}\n\nOutline:\n${f.outline || "(no headings)"}\n\nFirst lines:\n${f.firstLines}`,
      )
      .join("\n\n---\n\n"),
  validate: (out, input) => {
    const want = new Set(input.files.map((f) => f.path));
    const got = out.files.map((f) => f.path);
    const missing = [...want].filter((p) => !got.includes(p));
    if (missing.length) return `missing files: ${missing.join(", ")}`;
    const extra = got.filter((p) => !want.has(p));
    if (extra.length) return `unknown files: ${extra.join(", ")}`;
    for (const f of out.files) {
      if (f.role === "mixed" && (!f.sections || f.sections.length < 2)) return `${f.path} is "mixed" but lists fewer than two sections`;
    }
    return undefined;
  },
};
