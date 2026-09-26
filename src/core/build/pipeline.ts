import { join } from "node:path";
import { exists, readJsonOr, remove, writeJson } from "../fsutil";
import { cubePaths } from "../paths";
import { loadConfig } from "../config";
import { listProjectFiles } from "../scan";
import { git, gitRoot } from "../git";
import { fmtInt } from "../tokens";
import { scanCandidates, type Candidate } from "./scan";
import { classifyCandidates, classifyEstimate, describeClass, type Classified } from "./classify";
import { estimateBuild, readSource, toConfirmed, type ConfirmedSource, type Estimate } from "./sources";
import { orphanPlaceholders } from "../archive";
import type { RunContext } from "../../ai/runner";
import { writeRecipe } from "./recipeWriter";
import { loadRecipe, saveRecipe, type Recipe } from "./recipe";
import { dryRun } from "./dryrun";
import type { Chunk, RefHit } from "./split";
import type { Asker } from "../../setup/ask";
import type { AIBackend } from "../../ai/backends";
import type { Preset } from "../../ai/tiers";

/**
 * The build pipeline for existing projects (plan 6). Each stage saves its
 * result in context-cube/.logs/build/, so a stopped build resumes without
 * paying for AI steps twice. Stages that need a person pause and ask; every
 * question has a default.
 */

export const STAGES = ["scan", "classify", "confirm", "estimate", "recipe", "split", "rows", "review", "place", "gitextras", "enrich", "codelinks", "backlinks", "check", "spotcheck", "install"] as const;
export type Stage = (typeof STAGES)[number];

export interface BuildState {
  version: 1;
  done: Stage[];
  candidates?: Candidate[];
  classes?: Classified[];
  sources?: ConfirmedSource[];
  estimate?: Estimate;
  approvedEstimate?: boolean;
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

/** Runs stages in order, skipping those already done. Returns the state. */
export async function runPipeline(ctx: BuildContext, stages: Partial<Record<Stage, (ctx: BuildContext, s: BuildState) => Promise<void>>> = {}): Promise<BuildState> {
  const all = { ...CORE_STAGES, ...stages };
  const state = loadState(ctx.root);
  state.startedAt ??= new Date().toISOString();
  for (const stage of STAGES) {
    const fn = all[stage];
    if (!fn) continue;
    if (!state.done.includes(stage)) {
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
  const ok = await ctx.ask.confirm(`Read their headings and a short sample with a small AI model (about ${fmtInt(est)} tokens of your plan's usage)?`, true);
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
    const all = await ctx.ask.confirm(`Use these ${useful.length} file${useful.length === 1 ? "" : "s"} to build the cube?`, true);
    for (const c of useful) {
      const use = all || (await ctx.ask.confirm(`  Use ${c.path}?`, true));
      if (use) chosen.push(toConfirmed(c.role === "other" ? { ...c, role: "notes" } : c, byPath.get(c.path)));
    }
  }
  state.sources = chosen;
}

async function estimate(ctx: BuildContext, state: BuildState) {
  const sources = state.sources ?? [];
  const extras = extrasEstimate(ctx.root, sources, Number(state.codeFiles ?? 0));
  if (!sources.length && !extras.length) {
    state.estimate = { steps: [], total: 0 };
    state.approvedEstimate = true;
    return;
  }
  const est = estimateBuild(ctx.root, sources, Number(state.codeFiles ?? 0));
  est.steps.push(...extras);
  if (!sources.length) est.steps = est.steps.filter((s) => s.step === "row structure" || extras.includes(s));
  est.total = est.steps.reduce((n, s) => n + s.tokens, 0);
  state.estimate = est;
  ctx.ask.say(`\nThe AI steps will use roughly ${fmtInt(est.total)} tokens of your plan's usage (an estimate):`);
  for (const s of est.steps) ctx.ask.say(`  ${s.step}: ~${fmtInt(s.tokens)} (${s.note})`);
  const ok = await ctx.ask.confirm("Go ahead?", true);
  state.approvedEstimate = ok;
  if (!ok) throw new BuildStopped("Stopped before using any AI. Run the build again when you're ready.");
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
  const r = loadRecipe(ctx.root);
  if (!r) {
    state.chunks = 0;
    return;
  }
  const dr = dryRun(r, (p) => readSource(ctx.root, p));
  if (!dr.coverageOk) throw new Error("The recipe doesn't cover every line of the sources. See the dry run above; fix recipe.json and run the build again.");
  saveChunks(ctx.root, dr.chunks, dr.refs);
  state.chunks = dr.chunks.length;
  state.refs = { total: dr.refs.length, resolved: dr.refs.filter((x) => x.target).length };
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
function extrasEstimate(root: string, sources: ConfirmedSource[], codeFiles: number): { step: string; tokens: number; note: string }[] {
  const has = (r: string) => sources.some((s) => s.role === r || s.sections?.some((x) => x.role === r));
  const out: { step: string; tokens: number; note: string }[] = [];
  const commits = gitRoot(root) ? Number(git(["rev-list", "--count", "HEAD"], root).stdout.trim()) || 0 : 0;
  if (!has("history") && commits) {
    const groups = Math.min(commits, 400) / 2;
    out.push({ step: "history from git", tokens: Math.round(groups * 900 + 8000), note: "summarizes groups of commits" });
  }
  if (!has("invariants") && (commits || codeFiles)) out.push({ step: "candidate invariants", tokens: 25000, note: "drafts rules from reverted and fix commits and code comments, for you to approve" });
  if (!has("rules") && codeFiles) out.push({ step: "first rules", tokens: 8000, note: "drafts rules from the project's config files" });
  return out;
}

export function stageDone(root: string, stage: Stage): boolean {
  return loadState(root).done.includes(stage);
}

export function hasBuildState(root: string): boolean {
  return exists(join(buildDir(root), "state.json"));
}
