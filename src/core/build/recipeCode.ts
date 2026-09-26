import { analyze, splitLines } from "./markdown";
import type { SourceRecipe } from "./recipe";

/**
 * Code before AI (plan 2.2): a design doc, plan, or other note needs no AI to
 * split. Short notes stay whole; long ones split at their main headings.
 */
export const WHOLE_NOTE_MAX_LINES = 300;

export function codeRecipeForNotes(path: string, text: string, kind: "notes" | "catalog" = "notes"): SourceRecipe {
  const total = splitLines(text).length;
  if (total <= WHOLE_NOTE_MAX_LINES) {
    return { path, sections: [{ startLine: 1, kind, split: { mode: "whole" } }] };
  }
  const heads = analyze(text).flatMap((l) => (l.heading ? [l.heading] : []));
  for (const level of [2, 3, 1]) {
    if (heads.filter((h) => h.level === level).length >= 2) {
      return { path, sections: [{ startLine: 1, kind, split: { mode: "heading", level } }] };
    }
  }
  return { path, sections: [{ startLine: 1, kind, split: { mode: "whole" } }] };
}

/** Sources whose recipe code can write without asking the AI. */
export function codeCanWrite(role: string): boolean {
  return role === "notes";
}
