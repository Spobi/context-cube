import { findProjectRoot } from "../core/paths";
import { BuildStopped, endUnattended, loadState, resetBuild, runPipeline, STAGES, type BuildContext, type Stage } from "../core/build/pipeline";
import { fmtClock, makeSchedule, parseClock, realClock, resumeAt, sleepUntil, type Clock, type Schedule } from "../core/build/schedule";
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
  /** Start the part after the row review at this time, like "23:30" or "11:30pm". */
  at?: string;
  /** Where the hooks go (see setup's --shared and --personal). */
  shared?: boolean;
  ask?: Asker;
  backend?: AIBackend;
  /** For tests: a clock that doesn't really wait. */
  clock?: Clock;
}

/** `cube build`: builds (or resumes building) the cube from existing files. */
export async function build(opts: BuildOptions = {}): Promise<string[]> {
  const root = findProjectRoot(opts.cwd);
  if (opts.stopAfter && !(STAGES as readonly string[]).includes(opts.stopAfter)) {
    throw new CubeError(`Unknown stage "${opts.stopAfter}". Stages: ${STAGES.join(", ")}`);
  }
  if (opts.restart) resetBuild(root);
  const clock = opts.clock ?? realClock;
  let schedule: Schedule | undefined;
  if (opts.at) {
    const at = parseClock(opts.at, new Date(clock.now()));
    if (!at) throw new CubeError(`"${opts.at}" isn't a time this understands. Use one like --at 23:30 or --at 11:30pm.`);
    schedule = makeSchedule(at, clock);
  }
  const ask = opts.ask ?? terminalAsker({ yes: opts.yes });
  const ctx: BuildContext = {
    root,
    ask,
    backend: opts.backend,
    preset: opts.preset as Preset | undefined,
    stopAfter: opts.stopAfter as Stage | undefined,
    onlySources: opts.source,
    addSources: opts.add,
    schedule,
    clock,
    shared: opts.shared,
  };
  try {
    for (;;) {
      try {
        const state = await runPipeline(ctx, buildStages());
        const last = state.done[state.done.length - 1];
        return [last === "install" ? "" : `\nStopped after the "${last}" stage. Run \`cube build\` again to continue.`].filter(Boolean);
      } catch (err) {
        // Running on its own: wait for the limit to reset and carry on, until the cut-off.
        const s = ctx.schedule;
        const next = err instanceof UsageLimitError && s?.state === "running" ? resumeAt(s, err.message) : undefined;
        if (!s || !next) throw err;
        const now = new Date(clock.now());
        ctx.ask.say(`\nYour plan hit its usage limit at ${fmtClock(now)}${next.reset ? `; it resets at ${fmtClock(next.reset)}` : ""}. Waiting until ${fmtClock(next.at)}, then continuing where it stopped.`);
        await sleepUntil(clock, next.at);
        if (clock.now() > s.until.getTime()) {
          return [`\nStopped at ${fmtClock(new Date(clock.now()))} without finishing: it's past ${fmtClock(s.until)}, so it starts nothing new. Every finished step is saved; run the same command again to finish (add --at <time> to wait until then).`];
        }
      }
    }
  } catch (err) {
    if (err instanceof BuildStopped) return [err.message];
    if (err instanceof UsageLimitError) {
      const s = ctx.schedule;
      return [
        "",
        "Paused: your Claude plan hit a usage limit. Nothing is lost: every finished step is saved.",
        s?.state === "running"
          ? `It wouldn't reset before ${fmtClock(s.until)}, and the build starts nothing new after that. Run the same command again after the limit resets (add --at <time> to have it wait until then), and it continues where it stopped.`
          : "Run the same command again after the limit resets, and the build continues where it stopped. To have it wait for the reset on its own, add --at <time>, like --at 23:30.",
        `(${err.message.slice(0, 200)})`,
      ];
    }
    throw err;
  } finally {
    endUnattended(ctx);
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
