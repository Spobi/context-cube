import { join } from "node:path";
import { exists, readJsonOr, remove, writeJson } from "../fsutil";
import { cubePaths } from "../paths";
import { defaultConfig, loadConfig } from "../config";
import { listProjectFiles } from "../scan";
import { git, gitRoot } from "../git";
import { estimateTokens, fmtApprox, fmtInt } from "../tokens";
import { isAgentFile } from "../logs/memoryFiles";
import { scanCandidates, type Candidate } from "./scan";
import { classifyCandidates, classifyEstimate, describeClass, type Classified } from "./classify";
import { describeEstimate, estimateBuild, fmtByModel, readSource, toConfirmed, type ConfirmedSource, type Estimate, type EstimateStep } from "./sources";
import { awayAsker, fmtClock, fmtWait, makeSchedule, parseClock, realClock, waitForStart, type Clock, type Schedule } from "./schedule";
import { orphanPlaceholders } from "../archive";
import type { RunContext } from "../../ai/runner";
import { writeRecipe } from "./recipeWriter";
import { loadRecipe, saveRecipe, type Recipe } from "./recipe";
import { dryRun } from "./dryrun";
import type { Chunk, RefHit } from "./split";
import type { Asker } from "../../setup/ask";
import type { AIBackend } from "../../ai/backends";
import { TIER_NAME, TIER_SIZE, tierFor, type Preset } from "../../ai/tiers";

/**
 * The build pipeline for existing projects (plan 6). Each stage saves its
 * result in context-cube/.logs/build/, so a stopped build resumes without
 * paying for AI steps twice. Stages that need a person pause and ask; every
 * question has a default.
 */

export const STAGES = ["scan", "classify", "confirm", "estimate", "recipe", "split", "rows", "review", "place", "gitextras", "enrich", "codelinks", "backlinks", "check", "spotcheck", "install"] as const;
export type Stage = (typeof STAGES)[number];

/** What runs on its own when the person picks a later start: after the row review, up to the spot check. */
export const UNATTENDED: readonly Stage[] = ["place", "gitextras", "enrich", "codelinks", "backlinks", "check"];

/**
 * With no terminal (an agent relaying questions), stages that spend usage after
 * the go-ahead run in a background process, so they outlast the agent's command
 * and its session; the process stops at the next question for the person.
 */
export const BACKGROUND: readonly Stage[] = ["recipe", "rows", ...UNATTENDED];

export interface BuildState {
  version: 1;
  done: Stage[];
  candidates?: Candidate[];
  classes?: Classified[];
  sources?: ConfirmedSource[];
  estimate?: Estimate;
  approvedEstimate?: boolean;
  /** The later start the person picked (ISO), kept until the unattended part starts: a run without a terminal takes several commands to get there. */
  startAt?: string;
  chunks?: number;
  refs?: { total: number; resolved: number };
  [key: string]: unknown;
}

export interface BuildContext {
  root: string;
  ask: Asker;
  backend?: AIBackend;
  preset?: Preset;
  stopAfter?: Stage;
  /** Only these source paths (skips scan/classify questions for the rest). */
  onlySources?: string[];
  /** Extra sources to include even if classified as "other". */
  addSources?: string[];
  /** Where the hooks go: shared project settings, or personal (undefined: the cube's setting). */
  shared?: boolean;
  /** Set when the person picks a later start for the unattended stages. */
  schedule?: Schedule;
  clock?: Clock;
  /** Relaying questions with no terminal: hand the BACKGROUND stages to a background process. */
  detach?: boolean;
}

/** Thrown before a BACKGROUND stage when the build should carry on in a background process. */
export class Detach extends Error {
  constructor(public stage: Stage) {
    super(`carry on in the background from "${stage}"`);
  }
}

export function buildDir(root: string): string {
  return join(cubePaths(root).logs, "build");
}

export function loadState(root: string): BuildState {
  return readJsonOr<BuildState>(join(buildDir(root), "state.json"), { version: 1, done: [] });
}

export function saveState(root: string, s: BuildState): void {
  writeJson(join(buildDir(root), "state.json"), s);
}

export function resetBuild(root: string): void {
  remove(buildDir(root));
}

export function saveChunks(root: string, chunks: Chunk[], refs: RefHit[]): void {
  writeJson(join(buildDir(root), "chunks.json"), { chunks, refs });
}

export function loadChunks(root: string): { chunks: Chunk[]; refs: RefHit[] } {
  return readJsonOr(join(buildDir(root), "chunks.json"), { chunks: [], refs: [] });
}

function runCtx(ctx: BuildContext): Omit<RunContext, "root"> {
  return { backend: ctx.backend, preset: ctx.preset };
}

export class BuildStopped extends Error {}

function presetOf(ctx: BuildContext): Preset {
  if (ctx.preset) return ctx.preset;
  try {
    return loadConfig(ctx.root).preset;
  } catch {
    return "balanced";
  }
}

/** Waits for a later start before the unattended stages, and hands questions back to the person after them. */
async function unattended(ctx: BuildContext, state: BuildState, on: boolean): Promise<void> {
  const s = ctx.schedule!;
  if (on && s.state === "waiting") {
    const forget = () => {
      delete state.startAt;
      saveState(ctx.root, state);
    };
    // In a terminal, Ctrl+C during the wait cancels it: running again finishes now.
    if (!ctx.ask.relay) forget();
    const started = await waitForStart(s, ctx.ask);
    forget();
    if (!started) throw new BuildStopped("Didn't start. Run the command again to finish the build now, or add --at <time> to pick another time.");
    s.person = ctx.ask;
    ctx.ask = awayAsker(s.person);
    s.state = "running";
  } else if (!on && s.state === "running") {
    ctx.ask.say(`\nThe part that ran on its own finished at ${fmtClock(new Date(s.clock.now()))}.`);
    endUnattended(ctx);
  }
}

/** Gives questions back to the person and lets the computer sleep again. */
export function endUnattended(ctx: BuildContext): void {
  const s = ctx.schedule;
  if (!s || s.state === "done") return;
  if (s.state === "running") ctx.ask = s.person!;
  s.stopAwake?.();
  s.state = "done";
}

/** Runs stages in order, skipping those already done. Returns the state. */
export async function runPipeline(ctx: BuildContext, stages: Partial<Record<Stage, (ctx: BuildContext, s: BuildState) => Promise<void>>> = {}): Promise<BuildState> {
  const all = { ...CORE_STAGES, ...stages };
  const state = loadState(ctx.root);
  state.startedAt ??= new Date().toISOString();
  for (const stage of STAGES) {
    const fn = all[stage];
    if (!fn) continue;
    if (!state.done.includes(stage)) {
      if (ctx.detach && BACKGROUND.includes(stage)) throw new Detach(stage);
      if (ctx.schedule) await unattended(ctx, state, UNATTENDED.includes(stage));
      await fn(ctx, state);
      state.done.push(stage);
      saveState(ctx.root, state);
    }
    if (ctx.stopAfter === stage) break;
  }
  return state;
}

// ---------- stages 1–6 ----------

async function scan(ctx: BuildContext, state: BuildState) {
  const files = listProjectFiles(ctx.root);
  state.candidates = scanCandidates(ctx.root, files);
  state.codeFiles = files.length - state.candidates.length;
  ctx.ask.say(`Found ${state.candidates.length} markdown file${state.candidates.length === 1 ? "" : "s"} that could hold project memory.`);
  const orphans = orphanPlaceholders(ctx.root, files);
  if (orphans.length) ctx.ask.say(`  Skipping ${orphans.join(", ")}: archive placeholder${orphans.length === 1 ? "" : "s"} whose original isn't in context-cube/.state/archive/. Put the original back first to build from it.`);
}

async function classify(ctx: BuildContext, state: BuildState) {
  let cands = state.candidates ?? [];
  if (ctx.onlySources?.length) cands = cands.filter((c) => ctx.onlySources!.includes(c.path));
  if (!cands.length) {
    state.classes = [];
    return;
  }
  // Even this small step asks first: no usage is spent before an estimate (plan 7, Phase 8).
  const est = classifyEstimate(ctx.root, cands);
  const tier = tierFor("classify", presetOf(ctx));
  const ok = await ctx.ask.confirm(`Read their headings and a short sample with a ${TIER_SIZE[tier] === "smallest" ? "small" : TIER_SIZE[tier]} AI model (${TIER_NAME[tier]}, about ${fmtInt(est)} tokens of your plan's usage)?`, true, "read-sample");
  if (!ok) throw new BuildStopped("Stopped before using any AI. Run the build again when you're ready.");
  ctx.ask.say(`Reading headings and a short sample of each…`);
  const parallel = loadConfig(ctx.root).ai.parallel;
  state.classes = await classifyCandidates(ctx.root, cands, runCtx(ctx), parallel);
}

async function confirm(ctx: BuildContext, state: BuildState) {
  const classes = state.classes ?? [];
  const byPath = new Map((state.candidates ?? []).map((c) => [c.path, c]));
  const useful = classes.filter((c) => c.role !== "other" || ctx.addSources?.includes(c.path));
  const skipped = classes.filter((c) => c.role === "other" && !ctx.addSources?.includes(c.path));
  const chosen: ConfirmedSource[] = [];
  if (!useful.length) {
    ctx.ask.say("None of the files look like project memory.");
  } else {
    ctx.ask.say("\nHere's what I found:");
    for (const c of useful) ctx.ask.say(`  • ${describeClass(c)}`);
    if (skipped.length) ctx.ask.say(`  (Skipping ${skipped.length} that don't look like project memory: ${skipped.slice(0, 6).map((c) => c.path).join(", ")}${skipped.length > 6 ? ", …" : ""})`);
    const all = await ctx.ask.confirm(`Use these ${useful.length} file${useful.length === 1 ? "" : "s"} to build the cube?`, true, "use-files");
    for (const c of useful) {
      const use = all || (await ctx.ask.confirm(`  Use ${c.path}?`, true, `use:${c.path}`));
      if (use) chosen.push(toConfirmed(c.role === "other" ? { ...c, role: "notes" } : c, byPath.get(c.path)));
    }
  }
  state.sources = chosen;
}

async function estimate(ctx: BuildContext, state: BuildState) {
  const sources = state.sources ?? [];
  const preset = presetOf(ctx);
  const extras = extrasEstimate(ctx.root, sources, Number(state.codeFiles ?? 0), preset);
  if (!sources.length && !extras.length) {
    state.estimate = { steps: [], total: 0 };
    state.approvedEstimate = true;
    return;
  }
  const est = estimateBuild(ctx.root, sources, Number(state.codeFiles ?? 0), preset, state.candidates ?? []);
  est.steps.push(...extras);
  if (!sources.length) est.steps = est.steps.filter((s) => s.step === "row structure" || extras.includes(s));
  est.total = est.steps.reduce((n, s) => n + s.tokens, 0);
  state.estimate = est;
  for (const l of describeEstimate(est)) ctx.ask.say(l);

  // Offer a later start for the part after the row review, which is most of it.
  const now = est.steps.filter((s) => !s.later);
  const later = est.steps.filter((s) => s.later);
  let choice: string;
  if (later.length) {
    ctx.ask.say(`\nIf that's a lot for now, answer "later": the steps before your row review run now (${fmtApprox(now.reduce((n, s) => n + s.tokens, 0))}), and the rest starts on its own at a time you pick, like tonight after your plan's usage resets.`);
    choice = await ctx.ask.choose("Go ahead?", ["now", "later", "no"], ctx.schedule ? "later" : "now", "go-ahead");
  } else {
    choice = (await ctx.ask.confirm("Go ahead?", true, "go-ahead")) ? "now" : "no";
  }
  state.approvedEstimate = choice !== "no";
  if (choice === "no") throw new BuildStopped("Stopped before using any AI. Run the build again when you're ready.");
  if (choice === "now") {
    ctx.schedule = undefined;
    return;
  }
  const clock = ctx.clock ?? realClock;
  for (let i = 0; i < 3 && !ctx.schedule; i++) {
    const t = await ctx.ask.text("Start the rest at what time? (like 23:30 or 11:30pm; your plan's usage page shows when it resets: /usage in Claude Code, or Settings → Usage on claude.ai)", "", "start-at");
    const at = parseClock(t, new Date(clock.now()));
    if (at) ctx.schedule = makeSchedule(at, clock);
    else ctx.ask.say(t ? `  "${t}" isn't a time this understands.` : "  No time given.");
  }
  if (!ctx.schedule) throw new BuildStopped("Stopped before using any AI. To start the rest later, run the command again with --at <time>, like --at 23:30.");
  const s = ctx.schedule;
  state.startAt = s.at.toISOString();
  const at = s.at.getTime() - clock.now();
  ctx.ask.say(`\nNow: ${now.map((x) => x.step).join(" and ")}, ${fmtByModel(now)}, then you review the rows.`);
  ctx.ask.say(`At ${fmtClock(s.at, new Date(clock.now()))} (in ${fmtWait(at)}): the rest, ${fmtByModel(later)}, on its own.`);
}

async function recipe(ctx: BuildContext, state: BuildState) {
  const sources = state.sources ?? [];
  const existing = loadRecipe(ctx.root);
  const read = (p: string) => readSource(ctx.root, p);
  const known = new Set(existing?.sources.map((x) => x.path) ?? []);
  const missing = sources.filter((s) => !known.has(s.path));
  let r: Recipe = {
    version: 1,
    sources: (existing?.sources ?? []).filter((x) => sources.some((s) => s.path === x.path)),
    refs: existing?.refs ?? [],
  };
  if (existing && !missing.length) {
    ctx.ask.say("Using the existing recipe.json.");
  } else if (missing.length) {
    const fresh = await writeRecipe(ctx.root, missing, state.candidates ?? [], runCtx(ctx), loadConfig(ctx.root).ai.parallel, (t) => ctx.ask.say(t));
    const order = new Map(sources.map((s, i) => [s.path, i]));
    r = {
      version: 1,
      sources: [...r.sources, ...fresh.sources].sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0)),
      refs: [...r.refs, ...fresh.refs.filter((x) => !r.refs.some((y) => y.pattern === x.pattern && y.kind === x.kind))],
    };
  }
  saveRecipe(ctx.root, r);
  const dr = dryRun(r, read);
  ctx.ask.say(`\nRecipe dry run:\n${dr.report}`);
}

async function split(ctx: BuildContext, state: BuildState) {
  let r = loadRecipe(ctx.root);
  if (!r) {
    state.chunks = 0;
    return;
  }
  const read = (p: string) => readSource(ctx.root, p);
  let dr = dryRun(r, read);
  if (!dr.coverageOk) throw new Error("The recipe doesn't cover every line of the sources. See the dry run above; fix recipe.json and run the build again.");
  const asNotes = await offerRulesAsNotes(ctx, r, dr.chunks);
  if (asNotes) {
    r = asNotes;
    saveRecipe(ctx.root, r);
    dr = dryRun(r, read);
  }
  saveChunks(ctx.root, dr.chunks, dr.refs);
  state.chunks = dr.chunks.length;
  state.refs = { total: dr.refs.length, resolved: dr.refs.filter((x) => x.target).length };
}

/**
 * Rules load into every session, so they have a ceiling (limits.blockTokens),
 * and nothing becomes one without a person's say. Rules from files that aren't
 * agent instructions are offered to be filed as notes instead (placed by the
 * row proposal in the rows they're about, loading only when a task needs them):
 * always, when they're headed sections or long entries of a document (a plan's
 * "what we keep" section, a release runbook), and all of them when the rules
 * would go over the ceiling. Short listed rules from a house-rules file stay.
 * Returns the changed recipe, or undefined to keep it.
 */
async function offerRulesAsNotes(ctx: BuildContext, recipe: Recipe, chunks: Chunk[]): Promise<Recipe | undefined> {
  const config = exists(cubePaths(ctx.root).config) ? loadConfig(ctx.root) : defaultConfig();
  const tokens = (c: Chunk) => estimateTokens(c.text.length, config.tokens.charsPerToken);
  const rules = chunks.filter((c) => c.kind === "rules" && c.role === "entry");
  const total = rules.reduce((n, c) => n + tokens(c), 0);
  const limit = config.limits.blockTokens;
  const over = total > limit;
  const sectionOf = (c: Chunk) => [...(recipe.sources.find((s) => s.path === c.source)?.sections ?? [])].sort((a, b) => a.startLine - b.startLine)[c.section];
  const planLike = (c: Chunk) => sectionOf(c)?.split.mode !== "items" || tokens(c) > 150;
  const movable = rules.filter((c) => !isAgentFile(c.source) && (over || planLike(c)));
  if (!movable.length) return undefined;
  const bySource = new Map<string, Chunk[]>();
  for (const c of movable) bySource.set(c.source, [...(bySource.get(c.source) ?? []), c]);
  const n = movable.length;
  ctx.ask.say(
    over
      ? `\nThe rules found would load about ${fmtApprox(total).slice(1)} tokens into every session; the ceiling is about ${fmtApprox(limit).slice(1)}. ${n} of them come from files that aren't agent instructions, so they may be plans or procedures rather than rules for every task:`
      : `\n${n} of the rules found ${n === 1 ? "is a section" : "are sections"} of ${bySource.size === 1 ? "a file" : "files"} that ${bySource.size === 1 ? "isn't" : "aren't"} agent instructions, and read more like ${n === 1 ? "a plan or procedure" : "plans or procedures"} than rules for every task. As rules, they'd load into every session (about ${fmtApprox(movable.reduce((m, c) => m + tokens(c), 0)).slice(1)} tokens):`,
  );
  for (const [path, cs] of bySource) {
    ctx.ask.say(`  • ${path}: ${cs.length} (${fmtApprox(cs.reduce((m, c) => m + tokens(c), 0))} tokens), such as "${(cs[0].title ?? "").slice(0, 70)}"`);
  }
  const ok = await ctx.ask.confirm("File those with the notes instead, in the rows they're about, so they load only when a task needs them?", true, "rules-as-notes");
  if (!ok) return undefined;
  const asked = new Set(movable.map((c) => sectionOf(c)));
  return {
    ...recipe,
    sources: recipe.sources.map((s) => ({
      ...s,
      sections: s.sections.map((sec) => (asked.has(sec) ? { ...sec, kind: "notes" as const, split: sec.split.mode === "items" ? { mode: "whole" as const } : sec.split } : sec)),
    })),
  };
}

const CORE_STAGES: Partial<Record<Stage, (ctx: BuildContext, s: BuildState) => Promise<void>>> = {
  scan,
  classify,
  confirm,
  estimate,
  recipe,
  split,
};

/** AI steps for projects without history or invariants files: history from git, candidate invariants. */
function extrasEstimate(root: string, sources: ConfirmedSource[], codeFiles: number, preset: Preset): EstimateStep[] {
  const has = (r: string) => sources.some((s) => s.role === r || s.sections?.some((x) => x.role === r));
  const out: EstimateStep[] = [];
  const on = (ai: string) => tierFor(ai, preset);
  const commits = gitRoot(root) ? Number(git(["rev-list", "--count", "HEAD"], root).stdout.trim()) || 0 : 0;
  if (!has("history") && commits) {
    // The commits become history entries without AI (at most 200); the summaries step reads them,
    // up to 12 a call, each call carrying the boxes it may link to (see estimateBuild).
    const groups = Math.min(200, Math.ceil(Math.min(commits, 400) / 2));
    const targets = 45 * (6 + Math.min(150, Math.round(codeFiles * 0.4)));
    const tokens = Math.ceil(groups / 12) * 2 * (3000 + targets) + groups * (300 + 1250);
    out.push({ step: "history from git", tokens, note: "summarizes groups of commits", tier: on("history-summaries"), later: true });
  }
  if (!has("invariants") && (commits || codeFiles)) out.push({ step: "candidate invariants", tokens: 40_000, note: "drafts rules from reverted and fix commits and code comments, for you to approve", tier: on("candidate-invariants"), later: true });
  if (!has("rules") && codeFiles) out.push({ step: "first rules", tokens: 20_000, note: "drafts rules from the project's config files", tier: on("interview-rules"), later: true });
  return out;
}

export function stageDone(root: string, stage: Stage): boolean {
  return loadState(root).done.includes(stage);
}

export function hasBuildState(root: string): boolean {
  return exists(join(buildDir(root), "state.json"));
}
