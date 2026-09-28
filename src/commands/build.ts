import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cubePaths, findProjectRoot, TOOL_COMMAND } from "../core/paths";
import { buildDir, BuildStopped, Detach, endUnattended, loadState, resetBuild, runPipeline, saveState, STAGES, UNATTENDED, type BuildContext, type Stage } from "../core/build/pipeline";
import { fmtClock, makeSchedule, parseClock, realClock, resumeAt, sleepUntil, type Clock, type Schedule } from "../core/build/schedule";
import { NeedsAnswer, needsAnswerMessage, parseAnswers, terminalAsker, type Asker } from "../setup/ask";
import { ensureDir, exists, readJsonOr, remove, writeJson } from "../core/fsutil";
import { installTool } from "../core/tool";
import { defaultConfig, loadConfig, saveConfig } from "../core/config";
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
  /** The person's answers, relayed by an agent when there's no terminal: `--answer key=value`. */
  answer?: string[];
  answers?: Record<string, string>;
  /** Set in the process that runs the build's long part in the background. */
  backgroundChild?: boolean;
  /** Started by setup, which finishes the job once the build is done. */
  viaSetup?: boolean;
  ask?: Asker;
  backend?: AIBackend;
  /** For tests: a clock that doesn't really wait. */
  clock?: Clock;
  /** For tests: starts the background process instead of spawning one; returns its process id. */
  startBackground?: (root: string, args: string[]) => number | undefined;
}

/** `cube build`: builds (or resumes building) the cube from existing files. */
export async function build(opts: BuildOptions = {}): Promise<string[]> {
  const root = findProjectRoot(opts.cwd);
  if (opts.stopAfter && !(STAGES as readonly string[]).includes(opts.stopAfter)) {
    throw new CubeError(`Unknown stage "${opts.stopAfter}". Stages: ${STAGES.join(", ")}`);
  }
  const running = backgroundBuild(root);
  if (running && !opts.backgroundChild) {
    return [`A build is already running in the background (since ${fmtClock(new Date(running.started))}). See how it's going: ${TOOL_COMMAND} build-status`];
  }
  if (opts.restart) resetBuild(root);
  const clock = opts.clock ?? realClock;
  const st = loadState(root);
  delete st.waitingFor;
  if (opts.viaSetup) st.viaSetup = true;
  let schedule: Schedule | undefined;
  if (opts.at) {
    const at = parseClock(opts.at, new Date(clock.now()));
    if (!at) throw new CubeError(`"${opts.at}" isn't a time this understands. Use one like --at 23:30 or --at 11:30pm.`);
    schedule = makeSchedule(at, clock);
    if (st.done.includes("estimate")) st.startAt = at.toISOString();
  } else if (st.startAt && !UNATTENDED.every((x) => st.done.includes(x))) {
    // The later start picked earlier: without a terminal, several commands lead up to it.
    schedule = makeSchedule(new Date(st.startAt), clock);
  }
  // build-status shows the background log only while it's the latest news.
  st.lastRunInBackground = !!opts.backgroundChild;
  if (st.done.length || opts.viaSetup || opts.backgroundChild) saveState(root, st);
  const ask = opts.ask ?? terminalAsker({ yes: opts.yes, answers: opts.answers ?? parseAnswers(opts.answer) });
  const stopAwake = opts.backgroundChild ? clock.keepAwake?.() : undefined;
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
    detach: !!ask.relay && !opts.backgroundChild,
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
    if (err instanceof Detach) return startInBackground(root, opts, ctx);
    if (err instanceof NeedsAnswer) {
      const now = loadState(root);
      now.waitingFor = { key: err.key, question: err.question, kind: err.kind, choices: err.choices };
      saveState(root, now);
      // The background part prints to a log: name the command the person started with.
      const rerun = opts.backgroundChild ? (now.viaSetup ? "the setup command (npx context-cube, as it was started)" : `the build command (${TOOL_COMMAND} build)`) : undefined;
      return needsAnswerMessage(err, rerun);
    }
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
    stopAwake?.();
    if (opts.backgroundChild) forgetBackground(root, process.pid);
  }
}

// ---------- the long part, in the background (no terminal) ----------

interface BackgroundBuild {
  pid: number;
  started: string;
}

function backgroundFile(root: string): string {
  return join(buildDir(root), "background.json");
}

export function backgroundLog(root: string): string {
  return join(buildDir(root), "background.log");
}

const LOG_MARK = "=== background build started";

/** The build running in the background, if one is. */
export function backgroundBuild(root: string): BackgroundBuild | undefined {
  const b = readJsonOr<BackgroundBuild | undefined>(backgroundFile(root), undefined);
  if (!b?.pid) return undefined;
  if (b.pid === process.pid) return b;
  try {
    process.kill(b.pid, 0);
    return b;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return b;
    remove(backgroundFile(root));
    return undefined;
  }
}

function forgetBackground(root: string, pid: number): void {
  const b = readJsonOr<BackgroundBuild | undefined>(backgroundFile(root), undefined);
  if (b?.pid === pid) remove(backgroundFile(root));
}

function spawnBackground(root: string, args: string[]): number | undefined {
  const log = backgroundLog(root);
  const fd = openSync(log, "a");
  try {
    const child = spawn(process.execPath, [cubePaths(root).toolFile, ...args], { cwd: root, detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/**
 * Without a terminal, an agent runs the build one command at a time, and its
 * commands time out. So the stages that spend usage after the go-ahead run in
 * a background process, from the project's copy of the tool, until the next
 * question for the person; `build-status` shows how it's going and the question.
 */
function startInBackground(root: string, opts: BuildOptions, ctx: BuildContext): string[] {
  installTool(root);
  if (opts.shared !== undefined) {
    // The background process installs the hooks; it reads where from the config.
    const c = exists(cubePaths(root).config) ? loadConfig(root) : defaultConfig();
    c.hooks.scope = opts.shared ? "shared" : "local";
    saveConfig(root, c);
  }
  const args = ["build", "--background-child", ...(ctx.preset ? ["--preset", ctx.preset] : []), ...(opts.stopAfter ? ["--stop-after", opts.stopAfter] : [])];
  ensureDir(buildDir(root));
  appendFileSync(backgroundLog(root), `\n${LOG_MARK} ${new Date().toISOString()} ===\n`);
  const pid = (opts.startBackground ?? spawnBackground)(root, args);
  if (!pid) return ["Couldn't start the build in the background. Run the same command in a terminal instead, where it can run in the foreground."];
  writeJson(backgroundFile(root), { pid, started: new Date().toISOString() } satisfies BackgroundBuild);
  const s = ctx.schedule;
  const later = s && s.at.getTime() > (ctx.clock ?? realClock).now();
  return [
    "",
    `The build carries on in the background now, so it keeps going after this command ends${later ? `. It waits until ${fmtClock(s!.at)} to start the rest` : ""}.`,
    "  • Leave the computer on and plugged in, with the lid open: nothing runs while it's asleep.",
    `  • See how it's going: ${TOOL_COMMAND} build-status`,
    "    It stops when it needs the person's answer (to review the proposed rows, and at the spot check at the end); build-status then shows the question and how to answer it.",
    `  • To stop it: ${TOOL_COMMAND} build-status --stop (it keeps its place; running the build again carries on).`,
    `  • The full output goes to ${relative(root, backgroundLog(root))}.`,
  ];
}

/** `cube build-status`: which stages are done, whether a background build is running, and any question waiting for the person. */
export function buildStatus(opts: { cwd?: string; stop?: boolean }): string[] {
  const root = findProjectRoot(opts.cwd);
  const s = loadState(root);
  const bg = backgroundBuild(root);
  if (opts.stop) {
    if (!bg) return ["No build is running in the background."];
    try {
      process.kill(process.platform === "win32" ? bg.pid : -bg.pid, "SIGTERM");
    } catch {
      try {
        process.kill(bg.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    remove(backgroundFile(root));
    return ["Stopped the background build. It keeps its place: running the build again carries on from the last finished step."];
  }
  if (!s.done.length && !bg) return ["No build in progress."];
  const next = STAGES.find((x) => !s.done.includes(x));
  const out: string[] = [];
  if (bg) out.push(`Running in the background since ${fmtClock(new Date(bg.started))}.`);
  if (s.startAt) out.push(`The rest of the build starts at ${fmtClock(new Date(String(s.startAt)))}.`);
  out.push(`Done: ${s.done.join(", ") || "nothing yet"}`, next ? `Next: ${next}` : "The build is complete.");
  const tail = bg || s.lastRunInBackground ? logTail(root) : [];
  if (tail.length) out.push("", `Latest output (${relative(root, backgroundLog(root))}):`, ...tail);
  const waiting = s.waitingFor as { key: string; question: string; kind?: NeedsAnswer["kind"]; choices?: string[] } | undefined;
  if (!bg && waiting && !tail.some((l) => l.includes(`--answer ${waiting.key}=`))) {
    out.push(...needsAnswerMessage(new NeedsAnswer(waiting.key, waiting.question, waiting.kind ?? "text", waiting.choices), s.viaSetup ? "the setup command (npx context-cube, as it was started)" : `the build command (${TOOL_COMMAND} build)`));
  }
  if (!next && s.viaSetup && !s.setupDone) out.push("", "The build is done. Run the setup command again (npx context-cube) to finish: it handles the original files and sums up.");
  return out;
}

/** The background log since the last background start: the part the person needs now. */
function logTail(root: string, max = 80): string[] {
  const path = backgroundLog(root);
  if (!exists(path)) return [];
  const text = readFileSync(path, "utf8");
  const start = text.lastIndexOf(LOG_MARK);
  const lines = (start < 0 ? text : text.slice(text.indexOf("\n", start) + 1)).split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.length > max ? ["…", ...lines.slice(-max)] : lines;
}

/** `cube recipe check`: dry-runs recipe.json and reports what it would produce. Writes nothing. */
export function recipeCheck(opts: { cwd?: string }): string[] {
  const root = findProjectRoot(opts.cwd);
  const recipe = loadRecipe(root);
  if (!recipe) throw new CubeError("There's no recipe.json yet. `cube build` writes one.");
  const dr = dryRun(recipe, (p) => readSource(root, p));
  return [dr.report];
}
