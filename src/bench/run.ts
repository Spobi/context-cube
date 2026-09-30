import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { appendLine, ensureDir, readJsonl, writeJson, writeText } from "../core/fsutil";
import { git } from "../core/git";
import { loadEdits, loadReads } from "../core/logs/store";
import { buildReport } from "../core/logs/report";
import { computeStats } from "../core/stats/reads";
import { loadConfig } from "../core/config";
import { detectMemoryFiles } from "../core/logs/memoryFiles";
import { LIMIT_RE, UsageLimitError } from "../ai/runner";
import { claudeBin } from "../adapters/claude-code/bin";
import { prepareCopies, resetCopy, type Copies } from "./copies";
import { benchDir, type Task, type TasksFile } from "./tasks";
import { measureRetrieval, requiredFor, type Required, type Retrieval } from "./retrieval";

/**
 * Runs each task several times in each copy (Phase 9): non-interactive, with
 * permissions set in advance, no deploy credentials, and a reset between runs.
 * Captures cost, tokens, turns, duration, code changes, check results, and the
 * read report for that session.
 */

export type CopyName = "files" | "cube";

export interface RunRecord {
  id: string;
  task: string;
  copy: CopyName;
  n: number;
  session?: string;
  ok: boolean;
  error?: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  turns?: number;
  durationMs?: number;
  checkPassed?: boolean;
  changedFiles: string[];
  reads?: {
    memoryTokens: number;
    cubeTokens: number;
    otherTokens: number;
    read?: number;
    conservative?: number;
    upper?: number;
    /** Cube copy, when the transcript was found: boxes opened, and those with no sign of use. */
    opened?: number;
    unused?: number;
    unusedTokens?: number;
  };
  /** Were the task's invariants found before the first edit, and at what cost. */
  retrieval?: Retrieval;
  dir: string;
}

const BASE_TOOLS = ["Read", "Edit", "Write", "Grep", "Glob", "Task", "Agent", "Bash(node context-cube/.tool/cube.mjs:*)"];

/** No deploy credentials: only the environment an agent needs to run. */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_\w+|TERM|TMPDIR|TZ|XDG_\w+|CLAUDE_CONFIG_DIR|NODE_\w+|CUBE_CLAUDE_BIN)$/;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (keep.test(k)) out[k] = v;
  return out;
}

function claude(args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(claudeBin(), args, { cwd, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: String(err), code: -1 });
    });
  });
}

function memoryFilesOf(path: string): string[] {
  try {
    return loadConfig(path).memoryFiles ?? detectMemoryFiles(path);
  } catch {
    return detectMemoryFiles(path);
  }
}

function readsFor(path: string, copy: CopyName, session: string | undefined): RunRecord["reads"] {
  if (!session) return undefined;
  const reads = loadReads(path).filter((r) => r.session === session);
  const r = buildReport(path, reads, [], memoryFilesOf(path));
  const s = r.sessions[0]?.tokens ?? { memory: 0, cube: 0, other: 0, outside: 0 };
  const out: RunRecord["reads"] = { memoryTokens: s.memory, cubeTokens: s.cube, otherTokens: s.other };
  if (copy === "cube") {
    const edits = loadEdits(path).filter((e) => e.session === session);
    const st = computeStats(path, { reads, edits }).sessions.find((x) => x.session === session);
    if (st) Object.assign(out, { read: st.read, conservative: st.conservative, upper: st.upper });
    if (st?.opened) {
      const unused = st.opened.filter((o) => !o.used);
      Object.assign(out, { opened: st.opened.length, unused: unused.length, unusedTokens: unused.reduce((n, o) => n + o.tokens, 0) });
    }
  }
  return out;
}

function retrievalFor(path: string, copy: CopyName, session: string | undefined, required: Required[]): Retrieval | undefined {
  if (!session) return undefined;
  const reads = loadReads(path).filter((r) => r.session === session);
  const edits = loadEdits(path).filter((e) => e.session === session);
  return measureRetrieval(copy, required, reads, edits, memoryFilesOf(path));
}

export interface BenchOptions {
  only?: string[];
  runs?: number;
  model?: string;
  timeoutMs?: number;
  say?: (s: string) => void;
}

export async function runBench(root: string, tasks: TasksFile, opts: BenchOptions = {}): Promise<{ dir: string; records: RunRecord[] }> {
  const say = opts.say ?? (() => {});
  const copies: Copies = prepareCopies(root);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(benchDir(root), "results", stamp);
  ensureDir(outDir);
  writeJson(join(outDir, "meta.json"), { base: copies.base, model: opts.model ?? tasks.model, runs: opts.runs ?? tasks.runs, started: new Date().toISOString(), tasks: tasks.tasks });
  const runs = opts.runs ?? tasks.runs;
  const model = opts.model ?? tasks.model;
  const selected = tasks.tasks.filter((t) => !opts.only?.length || opts.only.includes(t.id));
  const records: RunRecord[] = [];
  const required = new Map(selected.map((t) => [t.id, requiredFor(copies.cube.path, t.invariants)]));
  const total = selected.length * runs * 2;
  let done = 0;
  for (const task of selected) {
    for (let n = 1; n <= runs; n++) {
      // Alternate which copy goes first, so neither always gets the warmer cache.
      const order: CopyName[] = n % 2 ? ["files", "cube"] : ["cube", "files"];
      for (const copy of order) {
        done++;
        say(`[${done}/${total}] ${task.id}, ${copy} copy, run ${n}`);
        const rec = await runOne(copies, task, copy, n, model, tasks.allow, outDir, opts.timeoutMs ?? 30 * 60_000, required.get(task.id) ?? []);
        records.push(rec);
        appendLine(join(outDir, "runs.jsonl"), JSON.stringify(rec));
        if (rec.error && LIMIT_RE.test(rec.error)) {
          throw new UsageLimitError(`Stopped after ${done - 1} of ${total} runs: ${rec.error.slice(0, 200)}. The finished runs are saved in ${outDir}; run the missing ones later with --only.`);
        }
      }
    }
  }
  return { dir: outDir, records };
}

async function runOne(copies: Copies, task: Task, copy: CopyName, n: number, model: string, allowAll: string[], outDir: string, timeoutMs: number, required: Required[]): Promise<RunRecord> {
  const c = copies[copy];
  resetCopy(c.path, c.prep);
  const id = `${task.id}.${copy}.${n}`;
  const dir = join(outDir, task.id, `${copy}-${n}`);
  ensureDir(dir);
  const allowed = [...BASE_TOOLS, ...allowAll, ...task.allow, ...(task.check ? [`Bash(${task.check})`] : [])];
  const args = ["-p", task.prompt, "--model", model, "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", ...allowed];
  const started = Date.now();
  const r = await claude(args, c.path, timeoutMs);
  const rec: RunRecord = { id, task: task.id, copy, n, ok: false, changedFiles: [], dir };
  writeText(join(dir, "result.json"), r.stdout || "{}");
  if (r.stderr) writeText(join(dir, "stderr.txt"), r.stderr);
  try {
    const d = JSON.parse(r.stdout);
    rec.session = d.session_id;
    rec.ok = !d.is_error;
    rec.costUsd = d.total_cost_usd;
    rec.tokensIn = (d.usage?.input_tokens ?? 0) + (d.usage?.cache_creation_input_tokens ?? 0) + (d.usage?.cache_read_input_tokens ?? 0);
    rec.tokensOut = d.usage?.output_tokens;
    rec.turns = d.num_turns;
    rec.durationMs = d.duration_ms ?? Date.now() - started;
    if (d.is_error) rec.error = String(d.result ?? d.subtype).slice(0, 500);
    writeText(join(dir, "final-message.md"), String(d.result ?? ""));
  } catch {
    rec.error = (r.stderr || r.stdout || "no output").slice(0, 500);
    rec.durationMs = Date.now() - started;
  }
  // What changed, compared with the prepared state (committed or not).
  git(["add", "-A"], c.path);
  const diff = git(["diff", "--cached", c.prep, "--", ".", ":(exclude)context-cube/.logs"], c.path);
  writeText(join(dir, "diff.patch"), diff.stdout);
  // More context around each change, for a judge that can't open the files.
  writeText(join(dir, "diff-wide.patch"), git(["diff", "--cached", "-U25", c.prep, "--", ".", ":(exclude)context-cube/.logs"], c.path).stdout);
  rec.changedFiles = git(["diff", "--cached", "--name-only", c.prep, "--", ".", ":(exclude)context-cube/.logs"], c.path).stdout.split("\n").filter(Boolean);
  git(["reset", "-q"], c.path);
  if (task.check) {
    const chk = spawnSync("sh", ["-c", task.check], { cwd: c.path, encoding: "utf8", env: cleanEnv(), timeout: 20 * 60_000 });
    rec.checkPassed = chk.status === 0;
    writeText(join(dir, "check.txt"), `$ ${task.check}\nexit ${chk.status}\n\n${(chk.stdout ?? "").slice(-20000)}\n${(chk.stderr ?? "").slice(-5000)}`);
  }
  rec.reads = readsFor(c.path, copy, rec.session);
  rec.retrieval = retrievalFor(c.path, copy, rec.session, required);
  return rec;
}

export function loadRuns(dir: string): RunRecord[] {
  return readJsonl<RunRecord>(join(dir, "runs.jsonl"));
}
