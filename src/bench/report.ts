import { join } from "node:path";
import { readJson, writeText } from "../core/fsutil";
import { fmtInt } from "../core/tokens";
import { loadRuns, type CopyName, type RunRecord } from "./run";
import { loadScores, type Score } from "./score";
import type { Task } from "./tasks";

/**
 * The bench report (Phase 9): results per task and copy, whatever they show.
 * Scores are the person's blind 1–5 ratings; the rest is measured.
 */

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f1 = (x: number) => (Number.isNaN(x) ? "–" : x.toFixed(1));
const money = (x: number) => (Number.isNaN(x) ? "–" : `$${x.toFixed(2)}`);
const int = (x: number) => (Number.isNaN(x) ? "–" : fmtInt(x));

interface Row {
  runs: number;
  correctness: number;
  invariants: number;
  scope: number;
  passRate: number;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  turns: number;
  minutes: number;
  memoryRead: number;
  cubeRead: number;
  errors: number;
  /** Retrieval: required invariants found before the first edit, of those required (summed over runs). */
  found: number;
  required: number;
  readsToFind: number;
  readsBeforeEdit: number;
  memoryBeforeEdit: number;
  /** Cube copy: box openings with no sign of use, of all openings. */
  unused: number;
  opened: number;
  /** Listed invariants the scorer said a change broke, of those judged yes or no. */
  violations: number;
  judged: number;
}

function summarize(runs: RunRecord[], scores: Map<string, Score>): Row {
  const sc = runs.map((r) => scores.get(r.id)).filter((s): s is Score => !!s);
  const checks = runs.filter((r) => r.checkPassed !== undefined);
  return {
    runs: runs.length,
    correctness: mean(sc.map((s) => s.correctness)),
    invariants: mean(sc.map((s) => s.invariants)),
    scope: mean(sc.map((s) => s.scope)),
    passRate: checks.length ? checks.filter((r) => r.checkPassed).length / checks.length : NaN,
    cost: mean(runs.filter((r) => r.costUsd !== undefined).map((r) => r.costUsd!)),
    tokensIn: mean(runs.filter((r) => r.tokensIn !== undefined).map((r) => r.tokensIn!)),
    tokensOut: mean(runs.filter((r) => r.tokensOut !== undefined).map((r) => r.tokensOut!)),
    turns: mean(runs.filter((r) => r.turns !== undefined).map((r) => r.turns!)),
    minutes: mean(runs.filter((r) => r.durationMs !== undefined).map((r) => r.durationMs! / 60000)),
    memoryRead: mean(runs.filter((r) => r.reads).map((r) => r.reads!.memoryTokens + r.reads!.cubeTokens)),
    cubeRead: mean(runs.filter((r) => r.reads?.read !== undefined).map((r) => r.reads!.read!)),
    errors: runs.filter((r) => r.error).length,
    found: runs.reduce((n, r) => n + (r.retrieval?.found ?? 0), 0),
    required: runs.reduce((n, r) => n + (r.retrieval?.required ?? 0), 0),
    readsToFind: mean(runs.filter((r) => r.retrieval?.readsToFind !== undefined).map((r) => r.retrieval!.readsToFind!)),
    readsBeforeEdit: mean(runs.filter((r) => r.retrieval).map((r) => r.retrieval!.readsBeforeEdit)),
    memoryBeforeEdit: mean(runs.filter((r) => r.retrieval).map((r) => r.retrieval!.memoryBeforeEdit)),
    unused: runs.reduce((n, r) => n + (r.reads?.unused ?? 0), 0),
    opened: runs.reduce((n, r) => n + (r.reads?.opened ?? 0), 0),
    violations: sc.reduce((n, s) => n + Object.values(s.respected ?? {}).filter((v) => v === "no").length, 0),
    judged: sc.reduce((n, s) => n + Object.values(s.respected ?? {}).filter((v) => v !== "unclear").length, 0),
  };
}

const ratio = (a: number, b: number) => (b ? `${a} of ${b} (${Math.round((a / b) * 100)}%)` : "–");

/** Why a copy did better or worse: did the agent find what the task needed, and what did it read to get there. */
function retrievalTable(rows: [string, Row][]): string[] {
  const out = [
    "| Copy | Invariants broken | Required invariants found before first edit | Reads to find the first | Reads before first edit | Memory read before first edit | Opened, possibly unused |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const [name, r] of rows) {
    out.push(`| ${name} | ${ratio(r.violations, r.judged)} | ${ratio(r.found, r.required)} | ${f1(r.readsToFind)} | ${f1(r.readsBeforeEdit)} | ${int(r.memoryBeforeEdit)} | ${name === "cube" ? ratio(r.unused, r.opened) : "–"} |`);
  }
  return out;
}

function table(rows: [string, Row][]): string[] {
  const out = [
    "| Copy | Runs | Correct | Invariants | Scope | Checks pass | Cost (list) | Tokens in | Tokens out | Turns | Minutes | Memory/cube read | Errors |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const [name, r] of rows) {
    out.push(`| ${name} | ${r.runs} | ${f1(r.correctness)} | ${f1(r.invariants)} | ${f1(r.scope)} | ${Number.isNaN(r.passRate) ? "–" : `${Math.round(r.passRate * 100)}%`} | ${money(r.cost)} | ${int(r.tokensIn)} | ${int(r.tokensOut)} | ${f1(r.turns)} | ${f1(r.minutes)} | ${int(r.memoryRead)} | ${r.errors} |`);
  }
  return out;
}

export function benchReport(dir: string): { path: string; text: string } {
  const meta = readJson<{ base: string; model: string; runs: number; started: string; tasks: Task[] }>(join(dir, "meta.json"));
  const runs = loadRuns(dir);
  const scores = new Map(loadScores(dir).map((s) => [s.run, s]));
  const by = (copy: CopyName, task?: string) => runs.filter((r) => r.copy === copy && (!task || r.task === task));
  const lines = [
    "# Context Cube bench report",
    "",
    `Commit ${meta.base.slice(0, 10)} · model ${meta.model} · ${meta.runs} runs per task per copy · started ${meta.started.slice(0, 16).replace("T", " ")}`,
    "",
    "The **files** copy has the project's current memory files; the **cube** copy has the Context Cube instead (the original files removed). Scores are blind 1–5 ratings by a person; the rest is measured. \"Memory/cube read\" is estimated tokens read from memory files or the cube (characters ÷ 4). Costs are the agent's list-price figures, not what a subscription pays.",
    "",
    `Scored runs: ${scores.size} of ${runs.length}.`,
    "",
    "## All tasks",
    "",
    ...table([
      ["files", summarize(by("files"), scores)],
      ["cube", summarize(by("cube"), scores)],
    ]),
    "",
    "### Retrieval",
    "",
    "Whether the agent found what the task needed, before its first code edit. An invariant listed for a task counts as found once half its text was shown to the agent (its Z1 in the cube copy, its lines of the original file in the files copy). \"Invariants broken\" comes from the scorer's yes/no per listed invariant. \"Possibly unused\" is boxes opened with no sign of use afterwards; it needs the session transcript.",
    "",
    ...retrievalTable([
      ["files", summarize(by("files"), scores)],
      ["cube", summarize(by("cube"), scores)],
    ]),
  ];
  for (const t of meta.tasks.filter((x) => runs.some((r) => r.task === x.id))) {
    lines.push("", `## ${t.id} (${t.size}${t.older ? ", depends on an older incident" : ""})`, "", t.prompt.trim().split("\n")[0], "");
    lines.push(...table([
      ["files", summarize(by("files", t.id), scores)],
      ["cube", summarize(by("cube", t.id), scores)],
    ]));
    lines.push("", ...retrievalTable([
      ["files", summarize(by("files", t.id), scores)],
      ["cube", summarize(by("cube", t.id), scores)],
    ]));
    const notes = runs.filter((r) => r.task === t.id && scores.get(r.id)?.note).map((r) => `- ${r.copy} run ${r.n}: ${scores.get(r.id)!.note}`);
    if (notes.length) lines.push("", "Notes from scoring:", ...notes);
  }
  const text = `${lines.join("\n")}\n`;
  const path = join(dir, "report.md");
  writeText(path, text);
  return { path, text };
}
