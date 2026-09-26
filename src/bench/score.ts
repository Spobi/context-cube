import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { appendLine, exists, readJson, readJsonl, readTextOr, writeText } from "../core/fsutil";
import { fmtInt } from "../core/tokens";
import type { Asker } from "../setup/ask";
import { loadRuns, type RunRecord } from "./run";
import { benchDir, type Task } from "./tasks";

/**
 * Blind scoring (Phase 9): the person sees each run's code changes without
 * knowing which copy produced them, and scores each 1–5 for correctness,
 * respecting invariants, and staying in scope. Then the report unblinds.
 */

export interface Score {
  run: string;
  correctness: number;
  invariants: number;
  scope: number;
  /** Per invariant the task must respect: did the change keep it? */
  respected?: Record<string, "yes" | "no" | "unclear">;
  note?: string;
  t: string;
}

export function latestResults(root: string): string | undefined {
  const dir = join(benchDir(root), "results");
  if (!exists(dir)) return undefined;
  const all = readdirSync(dir).sort();
  return all.length ? join(dir, all[all.length - 1]) : undefined;
}

export function loadScores(dir: string): Score[] {
  return readJsonl<Score>(join(dir, "scores.jsonl"));
}

/** A stable shuffle, so the order doesn't reveal the copy. */
function blindOrder(runs: RunRecord[], seed: string): RunRecord[] {
  const key = (r: RunRecord) => createHash("sha1").update(`${seed}:${r.id}`).digest("hex");
  return [...runs].sort((a, b) => key(a).localeCompare(key(b)));
}

export async function scoreRuns(dir: string, ask: Asker): Promise<number> {
  if (!ask.interactive) throw new Error("Scoring needs a person at a terminal.");
  const meta = readJson<{ tasks: Task[]; started: string }>(join(dir, "meta.json"));
  const scored = new Set(loadScores(dir).map((s) => s.run));
  const todo = blindOrder(loadRuns(dir).filter((r) => !scored.has(r.id)), meta.started);
  let n = 0;
  for (const [i, r] of todo.entries()) {
    const task = meta.tasks.find((t) => t.id === r.task)!;
    const diff = readTextOr(join(r.dir, "diff.patch"), "");
    const check = readTextOr(join(r.dir, "check.txt"), "");
    ask.say(`\n==================== Run ${i + 1} of ${todo.length} (task: ${task.id}) ====================`);
    ask.say(`Task:\n${task.prompt.trim()}`);
    if (task.invariants.length) ask.say(`Must respect: ${task.invariants.join(", ")}`);
    ask.say(`\nFiles changed: ${r.changedFiles.filter((f) => !f.startsWith("context-cube/")).join(", ") || "(none)"}`);
    ask.say(`The code changes are in ${join(r.dir, "diff.patch")} (${fmtInt(diff.split("\n").length)} lines).`);
    ask.say(diff.split("\n").slice(0, 200).join("\n"));
    if (diff.split("\n").length > 200) ask.say("…(open the file above for the rest)");
    if (check) ask.say(`\nCheck: ${check.split("\n").slice(0, 2).join(" · ")}`);
    const num = async (q: string) => {
      for (;;) {
        const a = await ask.text(`${q} (1–5)`, "");
        const v = Number(a);
        if (v >= 1 && v <= 5) return v;
        ask.say("  Please enter a number from 1 to 5.");
      }
    };
    const yesNo = async (q: string): Promise<"yes" | "no" | "unclear"> => {
      for (;;) {
        const a = (await ask.text(`${q} (y / n / ? if unclear)`, "")).trim().toLowerCase();
        if (a === "y" || a === "yes") return "yes";
        if (a === "n" || a === "no") return "no";
        if (a === "?" || a === "unclear") return "unclear";
        ask.say("  Please answer y, n, or ?.");
      }
    };
    const correctness = await num("Correctness: does it do the task right?");
    const invariants = await num("Invariants: does it respect the rules that must not be broken?");
    // One yes/no per listed invariant, for a violation rate that doesn't depend on a 1–5 feel.
    const respected: Record<string, "yes" | "no" | "unclear"> = {};
    for (const inv of task.invariants) respected[inv] = await yesNo(`  Does it keep ${inv}?`);
    const s: Score = {
      run: r.id,
      correctness,
      invariants,
      scope: await num("Scope: does it stay within the task?"),
      respected: task.invariants.length ? respected : undefined,
      note: (await ask.text("Any note? (optional)", "")) || undefined,
      t: new Date().toISOString(),
    };
    appendLine(join(dir, "scores.jsonl"), JSON.stringify(s));
    n++;
  }
  return n;
}

export function writeScoresTemplate(dir: string): string {
  const path = join(dir, "scores.jsonl");
  if (!exists(path)) writeText(path, "");
  return path;
}
