import { findProjectRoot } from "../core/paths";
import { BuildStopped, loadState, resetBuild, runPipeline, STAGES, type BuildContext, type Stage } from "../core/build/pipeline";
import { terminalAsker, type Asker } from "../setup/ask";
import { CubeError } from "../core/ops";
import { buildStages } from "../core/build/stages";
import { loadRecipe } from "../core/build/recipe";
import { dryRun } from "../core/build/dryrun";
import { readSource } from "../core/build/sources";
import type { AIBackend } from "../ai/backends";
import { UsageLimitError } from "../ai/runner";
import type { Preset } from "../ai/tiers";

export interface BuildOptions {
  cwd?: string;
  yes?: boolean;
  stopAfter?: string;
  restart?: boolean;
  source?: string[];
  add?: string[];
  preset?: string;
  ask?: Asker;
  backend?: AIBackend;
}

/** `cube build`: builds (or resumes building) the cube from existing files. */
export async function build(opts: BuildOptions = {}): Promise<string[]> {
  const root = findProjectRoot(opts.cwd);
  if (opts.stopAfter && !(STAGES as readonly string[]).includes(opts.stopAfter)) {
    throw new CubeError(`Unknown stage "${opts.stopAfter}". Stages: ${STAGES.join(", ")}`);
  }
  if (opts.restart) resetBuild(root);
  const ask = opts.ask ?? terminalAsker({ yes: opts.yes });
  const ctx: BuildContext = {
    root,
    ask,
    backend: opts.backend,
    preset: opts.preset as Preset | undefined,
    stopAfter: opts.stopAfter as Stage | undefined,
    onlySources: opts.source,
    addSources: opts.add,
  };
  try {
    const state = await runPipeline(ctx, buildStages());
    const last = state.done[state.done.length - 1];
    return [last === "install" ? "" : `\nStopped after the "${last}" stage. Run \`cube build\` again to continue.`].filter(Boolean);
  } catch (err) {
    if (err instanceof BuildStopped) return [err.message];
    if (err instanceof UsageLimitError) {
      return [
        "",
        "Paused: your Claude plan hit a usage limit. Nothing is lost: every finished step is saved.",
        "Run the same command again after the limit resets, and the build continues where it stopped.",
        `(${err.message.slice(0, 200)})`,
      ];
    }
    throw err;
  }
}

export function buildStatus(opts: { cwd?: string }): string[] {
  const root = findProjectRoot(opts.cwd);
  const s = loadState(root);
  if (!s.done.length) return ["No build in progress."];
  const next = STAGES.find((x) => !s.done.includes(x));
  return [`Done: ${s.done.join(", ")}`, next ? `Next: ${next}` : "The build is complete."];
}

/** `cube recipe check`: dry-runs recipe.json and reports what it would produce. Writes nothing. */
export function recipeCheck(opts: { cwd?: string }): string[] {
  const root = findProjectRoot(opts.cwd);
  const recipe = loadRecipe(root);
  if (!recipe) throw new CubeError("There's no recipe.json yet. `cube build` writes one.");
  const dr = dryRun(recipe, (p) => readSource(root, p));
  return [dr.report];
}
