import type { Step } from "../runner";
import prompt from "../prompts/recipe.md";
import { RecipeSchema, type Recipe } from "../../core/build/recipe";
import { validateRecipe } from "../../core/build/dryrun";

export interface RecipeSourceInput {
  path: string;
  role: string;
  sections?: { startLine: number; role: string }[];
  lines: number;
  outline: string;
  firstLines: string;
  samples: string[];
}

export interface RecipeIn {
  sources: RecipeSourceInput[];
}

/** The recipe step. `read` lets validation dry-run the recipe against the real files. */
export function recipeStep(read: (path: string) => string): Step<RecipeIn, Recipe> {
  return {
    name: "recipe",
    prompt,
    schema: RecipeSchema,
    render: (input) =>
      input.sources
        .map((s) => {
          const parts = [
            `## Source: ${s.path}`,
            `Role: ${s.role}${s.sections ? ` (sections: ${s.sections.map((x) => `line ${x.startLine} ${x.role}`).join("; ")})` : ""}. ${s.lines} lines.`,
            "",
            "Outline:",
            s.outline || "(no headings)",
            "",
            "First lines:",
            s.firstLines,
          ];
          if (s.samples.length) parts.push("", "Sample entries:", ...s.samples.map((x) => `${x}\n…`));
          return parts.join("\n");
        })
        .join("\n\n---\n\n"),
    validate: (recipe, input) => validateRecipe(recipe, input.sources.map((s) => s.path), read),
  };
}
