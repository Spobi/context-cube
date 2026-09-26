import { findProjectRoot } from "../core/paths";
import { CubeError } from "../core/ops";
import { terminalAsker } from "../setup/ask";
import { defaultTasksPath, loadTasks, writeStarter } from "../bench/tasks";
import { runBench } from "../bench/run";
import { latestResults, scoreRuns } from "../bench/score";
import { benchReport } from "../bench/report";
import { removeCopies } from "../bench/copies";
import { UsageLimitError } from "../ai/runner";

export function benchInit(opts: { cwd?: string }): string[] {
  const path = writeStarter(findProjectRoot(opts.cwd));
  return [`Tasks file: ${path}`, "Edit it with your own tasks (at least 5: 2 simple, 2 complex, 1 that depends on an older incident), then run: cube bench run"];
}

export async function benchRun(opts: { cwd?: string; tasks?: string; only?: string[]; runs?: string; model?: string }): Promise<string[]> {
  const root = findProjectRoot(opts.cwd);
  const tasks = loadTasks(opts.tasks ?? defaultTasksPath(root));
  const n = (opts.only?.length ? tasks.tasks.filter((t) => opts.only!.includes(t.id)).length : tasks.tasks.length) * Number(opts.runs ?? tasks.runs) * 2;
  const ask = terminalAsker();
  const ok = await ask.confirm(`This runs ${n} agent sessions (${opts.model ?? tasks.model}), one after another. It uses a lot of your plan's usage and can take hours. Go ahead?`, false);
  if (!ok) return ["Not started."];
  try {
    const r = await runBench(root, tasks, { only: opts.only, runs: opts.runs ? Number(opts.runs) : undefined, model: opts.model, say: (s) => console.log(s) });
    return [`Done: ${r.records.length} runs in ${r.dir}`, "Score them blind: cube bench score"];
  } catch (err) {
    if (err instanceof UsageLimitError) return [err.message];
    throw err;
  }
}

export async function benchScore(opts: { cwd?: string; results?: string }): Promise<string[]> {
  const root = findProjectRoot(opts.cwd);
  const dir = opts.results ?? latestResults(root);
  if (!dir) throw new CubeError("No bench results yet. Run: cube bench run");
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
