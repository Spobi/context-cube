import { join } from "node:path";
import { readJson } from "../core/fsutil";
import { findProjectRoot } from "../core/paths";
import { CubeError } from "../core/ops";
import { terminalAsker } from "../setup/ask";
import { defaultTasksPath, loadTasks, writeStarter, type TasksFile } from "../bench/tasks";
import { runBench, runsLeft } from "../bench/run";
import { latestResults, scoreRuns } from "../bench/score";
import { benchReport } from "../bench/report";
import { judgeRuns, unscoredRuns } from "../bench/judge";
import { removeCopies } from "../bench/copies";
import { UsageLimitError } from "../ai/runner";

export function benchInit(opts: { cwd?: string }): string[] {
  const path = writeStarter(findProjectRoot(opts.cwd));
  return [`Tasks file: ${path}`, "Edit it with your own tasks (at least 5: 2 simple, 2 complex, 1 that depends on an older incident), then run: cube bench run"];
}

export async function benchRun(opts: { cwd?: string; tasks?: string; only?: string[]; runs?: string; model?: string; resume?: boolean; results?: string }): Promise<string[]> {
  const root = findProjectRoot(opts.cwd);
  let resume: string | undefined;
  let tasks: TasksFile | undefined;
  if (opts.resume) {
    resume = opts.results ?? latestResults(root);
    if (!resume) throw new CubeError("No bench to continue yet. Start one with: cube bench run");
    if (opts.runs || opts.model) throw new CubeError("--resume keeps the model and the number of runs the bench started with.");
    try {
      tasks = loadTasks(opts.tasks ?? defaultTasksPath(root)); // only for the allowed tools, in results from before 0.3.8
    } catch {
      tasks = undefined;
    }
  } else tasks = loadTasks(opts.tasks ?? defaultTasksPath(root));
  const n = runsLeft(tasks, { only: opts.only, runs: opts.runs ? Number(opts.runs) : undefined, resume });
  if (resume && n <= 0) return [`Every run in ${resume} is done. Score them: cube bench score --ai (or cube bench score to do it yourself)`];
  const model = resume ? readJson<{ model: string }>(join(resume, "meta.json")).model : opts.model ?? tasks!.model;
  const ask = terminalAsker();
  const ok = await ask.confirm(`This runs ${n} agent session${n === 1 ? "" : "s"} (${model}), one after another${resume ? `, continuing ${resume}` : ""}. It uses a lot of your plan's usage and can take hours. Go ahead?`, false);
  if (!ok) return ["Not started."];
  try {
    const r = await runBench(root, tasks, { only: opts.only, runs: opts.runs ? Number(opts.runs) : undefined, model: opts.model, resume, say: (s) => console.log(s) });
    return [`Done: ${r.records.length} runs in ${r.dir}`, "Score them blind: cube bench score --ai (Opus) or cube bench score (you)"];
  } catch (err) {
    if (err instanceof UsageLimitError) return [err.message];
    throw err;
  }
}

export async function benchScore(opts: { cwd?: string; results?: string; ai?: boolean; yes?: boolean }): Promise<string[]> {
  const root = findProjectRoot(opts.cwd);
  const dir = opts.results ?? latestResults(root);
  if (!dir) throw new CubeError("No bench results yet. Run: cube bench run");
  if (opts.ai) {
    const todo = unscoredRuns(dir).length;
    if (!todo) return ["Every run is already scored. Write the report with: cube bench report"];
    const ask = terminalAsker({ yes: opts.yes });
    if (ask.interactive && !(await ask.confirm(`Opus will score ${todo} run${todo === 1 ? "" : "s"} blind, one call each (it never sees which copy made a change). This uses your plan's Opus usage. Go ahead?`, true))) return ["Not started."];
    try {
      const n = await judgeRuns(root, dir, { say: (s) => console.log(s) });
      const left = unscoredRuns(dir).length;
      return [`Opus scored ${n} run${n === 1 ? "" : "s"}.${left ? ` ${left} still unscored; run this again to retry them.` : ""}`, "Write the report with: cube bench report"];
    } catch (err) {
      if (err instanceof UsageLimitError) return [`${err.message}`, "The finished scores are saved; run this again after the reset."];
      throw err;
    }
  }
  const n = await scoreRuns(dir, terminalAsker());
  return [`Scored ${n} run${n === 1 ? "" : "s"}. Write the report with: cube bench report`];
}

export function benchReportCmd(opts: { cwd?: string; results?: string }): string[] {
  const root = findProjectRoot(opts.cwd);
  const dir = opts.results ?? latestResults(root);
  if (!dir) throw new CubeError("No bench results yet. Run: cube bench run");
  const r = benchReport(dir);
  return [r.text, `Saved: ${r.path}`];
}

export function benchClean(opts: { cwd?: string }): string[] {
  removeCopies(findProjectRoot(opts.cwd));
  return ["Removed the bench copies (the results are kept)."];
}
