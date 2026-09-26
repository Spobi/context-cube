import { z } from "zod";
import { exists, readJson, writeJson } from "../fsutil";
import { cubePaths } from "../paths";

/**
 * recipe.json (plan 3.11): how this project's source files are structured.
 * The AI writes it once; code follows it every time, so new entries cost no
 * tokens. People can read and edit it.
 */

export const SOURCE_KINDS = ["rules", "history", "invariants", "catalog", "notes"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SplitSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("heading"), level: z.number().int().min(1).max(6) }),
  z.object({ mode: z.literal("items") }),
  z.object({ mode: z.literal("whole") }),
]);
export type Split = z.infer<typeof SplitSchema>;

export const SectionSchema = z.object({
  /** 1-based line where this section starts. The first section starts at line 1. */
  startLine: z.number().int().min(1),
  title: z.string().optional(),
  kind: z.enum(SOURCE_KINDS),
  split: SplitSchema,
  /** Entries longer than this are split further. Omit to keep entries whole. */
  maxLines: z.number().int().min(10).optional(),
  subsplit: z.enum(["heading", "items"]).optional(),
  /** Regex on an entry's first line; group 1 is the entry's key (e.g. "1.0.8 (6)" or "21"). */
  key: z.string().optional(),
  /** Regex on an entry's first line; group 1 is a date (YYYY-MM-DD). */
  date: z.string().optional(),
  /** Regex on an entry's first line; group 1 is a ready-made one-line summary. */
  summary: z.string().optional(),
  /** History only: the order entries appear in the file. */
  order: z.enum(["newest-first", "oldest-first"]).optional(),
});
export type Section = z.infer<typeof SectionSchema>;

export const SourceRecipeSchema = z.object({
  path: z.string(),
  sections: z.array(SectionSchema).min(1),
});
export type SourceRecipe = z.infer<typeof SourceRecipeSchema>;

export const RefSchema = z.object({
  /** Regex found anywhere in the text; group 1 is the key of the entry it points to. */
  pattern: z.string(),
  /** The kind of entry it points to. */
  kind: z.enum(SOURCE_KINDS),
  /** Only entries from this source (optional). */
  source: z.string().optional(),
  note: z.string().optional(),
});
export type Ref = z.infer<typeof RefSchema>;

export const RecipeSchema = z.object({
  version: z.literal(1),
  sources: z.array(SourceRecipeSchema),
  refs: z.array(RefSchema).default([]),
});
export type Recipe = z.infer<typeof RecipeSchema>;

export function loadRecipe(root: string): Recipe | undefined {
  const p = cubePaths(root).recipe;
  if (!exists(p)) return undefined;
  return RecipeSchema.parse(readJson(p));
}

export function saveRecipe(root: string, recipe: Recipe): void {
  writeJson(cubePaths(root).recipe, RecipeSchema.parse(recipe));
}

/** Compiles a recipe regex. Patterns are JavaScript regular expressions, matched per line. */
export function compile(pattern: string, flags = ""): RegExp {
  return new RegExp(pattern, flags);
}

export function regexProblem(pattern: string | undefined, needsGroup = true): string | undefined {
  if (pattern === undefined) return undefined;
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    return `invalid regex ${JSON.stringify(pattern)}: ${(err as Error).message}`;
  }
  if (needsGroup && new RegExp(`${re.source}|`).exec("")!.length < 2) return `regex ${JSON.stringify(pattern)} needs a capture group`;
  return undefined;
}

/** Keys compare ignoring spaces and case: "1.0.8 (6)" matches "1.0.8(6)". */
export function normalizeKey(k: string): string {
  return k.replace(/\s+/g, "").toLowerCase();
}
