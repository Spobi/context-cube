import { join } from "node:path";
import { exists, readJsonOr, readTextOr, writeJson, writeText } from "../fsutil";
import { cubePaths } from "../paths";
import { loadConfig, saveConfig, defaultConfig } from "../config";
import { allBoxes, getBox, getRow, loadCube, type Box, type Cube } from "../cube";
import { createRow, bulkUpdateHeaders, type HeaderUpdate } from "../ops";
import { installTool } from "../tool";
import { writeStateScaffold } from "../../commands/core";
import { splitGenerated } from "../format/generated";
import { historyRoot, invariantsRoot, rulesRoot } from "../templates";
import { reindex } from "../index/index";
import { runChecks, renderIssues } from "../check/check";
import { addAliases } from "../state/state";
import { mapLimit, runStep, type RunContext } from "../../ai/runner";
import { rowsStep, type RowsOut, type PieceRef } from "../../ai/schemas/rows";
import { historyStep, invariantsStep, overviewsStep, type EnrichIn, type EnrichItem, type Target } from "../../ai/schemas/enrich";
import { recordQuality } from "../stats/ai";
import { fmtInt } from "../tokens";
import { readJsonl } from "../fsutil";
import { logFiles } from "../logs/store";
import { codeOutline } from "./outline";
import { linkCode } from "../code/links";
import { installAgents } from "../install";
import { approveText, proposeNew } from "../approvals";
import { readCommits, groupCommits, groupDetail } from "./gitHistory";
import { gatherEvidence, hasEvidence } from "./candidates";
import { candidatesStep } from "../../ai/schemas/candidates";
import { interview, interviewStep, projectFacts, type InterviewOutput } from "../../setup/interview";
import { slugify } from "../format/names";
import { TOOL_COMMAND } from "../paths";
import { loadRecipe, type Recipe } from "./recipe";
import { appendGlue, bulkCreate, chronological, effectiveDate, nameFor, sourceLabel, type BoxSpec } from "./place";
import { loadBoxState, saveBoxState } from "../state/state";
import { placedCoverage } from "./coverage";
import { buildDir, BuildStopped, loadChunks, type BuildContext, type BuildState, type Stage } from "./pipeline";
import type { Chunk } from "./split";
import type { AICallLog } from "../../ai/runner";
import type { Link } from "../format/header";

/**
 * Pipeline steps 7–15 (plan 6): row structure, review, place, enrich, code
 * links (Phase 5), backlinks and aliases, check and coverage, spot check, and
 * index and install.
 */

interface Placement {
  chunkToBox: Record<string, string>;
  rowByName: Record<string, string>;
  componentBoxes: string[];
  noteBoxes: string[];
  complete: boolean;
}

const placementPath = (root: string) => join(buildDir(root), "placement.json");
const proposalPath = (root: string) => join(buildDir(root), "rows.json");
const loadPlacement = (root: string) => readJsonOr<Placement | undefined>(placementPath(root), undefined);

function runCtx(ctx: BuildContext): Omit<RunContext, "root"> {
  return { backend: ctx.backend, preset: ctx.preset };
}

function entries(chunks: Chunk[], kind?: string): Chunk[] {
  return chunks.filter((c) => c.role === "entry" && (!kind || c.kind === kind));
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const rest = text.slice(max).split("\n").length;
  return `${text.slice(0, max)}\n…(cut here: about ${rest} more lines, not shown)`;
}

// ---------- 7. row structure ----------

function pieceRefs(chunks: Chunk[]): { refs: PieceRef[]; map: Record<string, string> } {
  const pieces = chunks.filter((c) => c.role === "entry" && (c.kind === "notes" || c.kind === "catalog"));
  const map: Record<string, string> = {};
  const refs = pieces.map((c, i) => {
    const id = `n${i + 1}`;
    map[id] = c.id;
    const title = `${c.title ?? "(untitled)"}${c.part ? ` (part ${c.part.index} of ${c.part.total})` : ""}`;
    return { id, source: c.source, title: title.slice(0, 110), lines: c.end - c.start + 1 };
  });
  return { refs, map };
}

async function proposeRows(ctx: BuildContext, chunks: Chunk[], recipe: Recipe | undefined, feedback?: string): Promise<RowsOut> {
  const { refs } = pieceRefs(chunks);
  const outline = codeOutline(ctx.root);
  if (!refs.length && outline.codeFiles < 5) return { rows: [], place: [] };
  const title = (c: Chunk) => (c.title ?? "").slice(0, 100);
  const history = recipe ? chronological(entries(chunks, "history"), recipe).reverse() : entries(chunks, "history");
  const input = {
    outline: outline.text,
    fixed: {
      rules: entries(chunks, "rules").map(title),
      history: history.filter((c) => !c.part || c.part.index === 1).map(title),
      invariants: entries(chunks, "invariants").map((c) => `${title(c)}${c.part ? ` (part ${c.part.index})` : ""}`),
    },
    pieces: refs,
    feedback,
  };
  ctx.ask.say(`Proposing the rows (the project's areas) from ${fmtInt(outline.codeFiles)} code files and ${refs.length} note pieces…`);
  const r = await runStep(rowsStep, input, { ...runCtx(ctx), root: ctx.root, label: "rows" });
  return r.output;
}

async function rows(ctx: BuildContext, state: BuildState) {
  const { chunks } = loadChunks(ctx.root);
  const proposal = await proposeRows(ctx, chunks, loadRecipe(ctx.root));
  writeJson(proposalPath(ctx.root), proposal);
  state.pieceMap = pieceRefs(chunks).map;
}

// ---------- 8. review ----------

function describeProposal(p: RowsOut): string[] {
  const out: string[] = ["", "Proposed rows (besides rules, history, and invariants):"];
  if (!p.rows.length) out.push("  (none: this project's memory fits in the three standard rows)");
  for (const r of p.rows) {
    const pieces = p.place.filter((x) => x.row === r.name).length;
    out.push(`  • ${r.name} (${r.type}): ${r.summary}`);
    out.push(`      open when: ${r.readWhen}`);
    const bits = [r.boxes.length ? `${r.boxes.length} box${r.boxes.length === 1 ? "" : "es"}: ${r.boxes.slice(0, 6).map((b) => b.name).join(", ")}${r.boxes.length > 6 ? ", …" : ""}` : "", pieces ? `${pieces} note piece${pieces === 1 ? "" : "s"}` : ""].filter(Boolean);
    if (bits.length) out.push(`      ${bits.join(" · ")}`);
  }
  return out;
}

async function review(ctx: BuildContext, state: BuildState) {
  for (let round = 0; round < 5; round++) {
    const proposal = readJsonOr<RowsOut>(proposalPath(ctx.root), { rows: [], place: [] });
    for (const l of describeProposal(proposal)) ctx.ask.say(l);
    if (!proposal.rows.length) return;
    const choice = await ctx.ask.choose("Accept these rows?", ["accept", "redo", "edit"], "accept");
    if (choice === "accept") return;
    if (choice === "edit") {
      throw new BuildStopped(`Edit ${proposalPath(ctx.root)}, then run \`cube build\` again to review it.`);
    }
    const feedback = await ctx.ask.text("What should change?", "");
    const { chunks } = loadChunks(ctx.root);
    const next = await proposeRows(ctx, chunks, loadRecipe(ctx.root), feedback || "Try a clearer split into rows.");
    writeJson(proposalPath(ctx.root), next);
  }
  void state;
}

// ---------- 9. place ----------

function ensureSkeleton(root: string): void {
  const p = cubePaths(root);
  installTool(root);
  const config = exists(p.config) ? loadConfig(root) : defaultConfig();
  if (!config.agents.length) config.agents = ["claude-code"];
  saveConfig(root, config);
  writeStateScaffold(root);
  const cube = loadCube(root);
  if (!getRow(cube, 0)) createRow(root, rulesRoot());
  if (!cube.rows.some((r) => r.type === "history")) createRow(root, historyRoot(config.history.unit));
  if (!cube.rows.some((r) => r.type === "invariants")) createRow(root, invariantsRoot());
}

/** A history unit from the entries' keys, when setup hasn't chosen one. */
export function inferHistoryUnit(history: Chunk[]): "build" | "release" | "day" | undefined {
  const keyed = history.filter((c) => c.key);
  if (!history.length) return undefined;
  if (keyed.filter((c) => /\(\d+\)/.test(c.key!)).length > keyed.length / 2) return "build";
  if (keyed.filter((c) => /\d+\.\d+/.test(c.key!)).length > keyed.length / 2) return "release";
  if (history.filter((c) => c.date).length > history.length / 2) return "day";
  return undefined;
}

async function place(ctx: BuildContext, state: BuildState) {
  const root = ctx.root;
  const existing = loadPlacement(root);
  if (existing?.complete) return;
  if (existing && !existing.complete) {
    throw new Error("A previous build stopped while placing boxes, so the cube may be half-filled. Delete the Y* folders in context-cube/ and run `cube build` again.");
  }
  const cube0 = loadCube(root);
  if (allBoxes(cube0).some((b) => !b.isRoot)) {
    throw new Error("This cube already has boxes. `cube build` fills a new cube; to add to an existing one, use `cube update` or the cube commands.");
  }
  const { chunks } = loadChunks(root);
  const recipe = loadRecipe(root);
  const proposal = readJsonOr<RowsOut>(proposalPath(root), { rows: [], place: [] });
  const pieceMap = (state.pieceMap ?? {}) as Record<string, string>;
  const placement: Placement = { chunkToBox: {}, rowByName: {}, componentBoxes: [], noteBoxes: [], complete: false };
  writeJson(placementPath(root), placement);

  const config = exists(cubePaths(root).config) ? loadConfig(root) : defaultConfig();
  if (!config.history.unit) {
    const hist = entries(chunks, "history");
    // Ask only when there is history and the entries don't say how they're grouped.
    const unit = inferHistoryUnit(hist) ?? (hist.length ? ((await ctx.ask.choose("Each history entry is one:", ["release", "build", "pr", "day", "commit", "session"], "release")) as any) : undefined);
    if (unit) {
      config.history.unit = unit;
      saveConfig(root, config);
    }
  }
  ensureSkeleton(root);
  let cube = loadCube(root);
  const rulesRow = getRow(cube, 0)!;
  const historyRow = cube.rows.find((r) => r.type === "history")!;
  const invRow = cube.rows.find((r) => r.type === "invariants")!;
  placement.rowByName = { rules: rulesRow.id, history: historyRow.id, invariants: invRow.id };

  // Proposed rows.
  for (const r of proposal.rows) {
    const row = createRow(root, { type: r.type, name: r.name, summary: r.summary, readWhen: r.readWhen, conventions: r.conventions, writtenBy: "ai" });
    placement.rowByName[r.name] = row.id;
  }
  cube = loadCube(root);
  const rowNum = (id: string) => Number(id.slice(1));
  const src = (c: Chunk) => ({ file: c.source, start: c.start, end: c.end });
  const record = (ids: string[], groups: Chunk[][]) => ids.forEach((id, i) => groups[i].forEach((c) => (placement.chunkToBox[c.id] = id)));

  // Rules → Y00: the rule itself is the Z0 body.
  const rules = entries(chunks, "rules");
  const ruleIds = bulkCreate(
    root,
    rulesRow.num,
    rules.map((c) => ({
      name: nameFor(c),
      summary: (c.title ?? "").slice(0, 200),
      readWhen: "Always.",
      body: c.text,
      source: sourceLabel(c),
      writtenBy: "migrated",
      sources: [{ ...src(c), drawer: 0 }],
    })),
  );
  record(ruleIds, rules.map((c) => [c]));

  // History → Y01, oldest first. Parts of one entry stay in one box.
  const hist = recipe ? chronological(entries(chunks, "history"), recipe) : entries(chunks, "history");
  const groups: Chunk[][] = [];
  for (const c of hist) {
    const last = groups[groups.length - 1];
    if (c.part && c.part.index > 1 && last && last[0].part?.of === c.part.of && last[0].source === c.source) last.push(c);
    else groups.push([c]);
  }
  const histIds = bulkCreate(
    root,
    historyRow.num,
    groups.map((g) => {
      const c = g[0];
      const wrapped = g.length > 1;
      return {
        name: nameFor(c),
        summary: c.summary ?? c.title ?? "History entry",
        readWhen: `Debugging or changing anything related to: ${(c.summary ?? c.title ?? "").slice(0, 120)}`,
        drawers: { 4: wrapped ? g.map((x) => `<!-- cube:from ${x.source} L${x.start}-L${x.end} -->\n${x.text}<!-- cube:end-from -->\n`).join("") : c.text },
        source: sourceLabel(c),
        writtenBy: "migrated" as const,
        sources: g.map((x) => ({ ...src(x), drawer: 4, wrapped })),
      };
    }),
  );
  record(histIds, groups);
  histIds.forEach((id, i) => {
    const date = effectiveDate(groups[i][0].id) ?? groups[i][0].date;
    const st = loadBoxState(root, id);
    if (st && date) saveBoxState(root, { ...st, date, historyKey: groups[i][0].key });
  });

  // Invariants → Y02: the text is Z1, word for word. Each part of a long topic is its own box.
  const inv = entries(chunks, "invariants");
  const invIds = bulkCreate(
    root,
    invRow.num,
    inv.map((c) => ({
      name: nameFor(c),
      summary: `${c.summary ?? c.title ?? "Invariants topic"}${c.part ? ` (part ${c.part.index} of ${c.part.total})` : ""}`,
      readWhen: `Before changing anything covered by: ${(c.part?.of ?? c.title ?? "").slice(0, 120)}`,
      drawers: { 1: c.text },
      source: sourceLabel(c),
      writtenBy: "migrated",
      sources: [{ ...src(c), drawer: 1 }],
    })),
  );
  record(invIds, inv.map((c) => [c]));
  // Migrated invariant text is approved as it stands; later changes need approval.
  invIds.forEach((id, i) => approveText(root, id, inv[i].text));

  // Proposed rows: component boxes first, then the note pieces placed there.
  const pieceRow = new Map<string, string>();
  const pieceBox = new Map<string, string>();
  for (const p of proposal.place) {
    if (!pieceMap[p.piece]) continue;
    pieceRow.set(pieceMap[p.piece], p.row);
    if (p.box) pieceBox.set(`${p.row}/${p.box}`, pieceMap[p.piece]);
  }
  const notes = chunks.filter((c) => c.role === "entry" && (c.kind === "notes" || c.kind === "catalog"));
  const byId = new Map(chunks.map((c) => [c.id, c]));
  for (const r of proposal.rows) {
    const num = rowNum(placement.rowByName[r.name]);
    // A component box can carry the note that is mainly about it, as its Z4.
    const inside: Chunk[] = [];
    const comp = bulkCreate(
      root,
      num,
      r.boxes.map((b) => {
        const chunk = byId.get(pieceBox.get(`${r.name}/${b.name}`) ?? "");
        if (!chunk) return { name: b.name, summary: b.summary, readWhen: b.readWhen, writtenBy: "ai" as const };
        inside.push(chunk);
        return { name: b.name, summary: b.summary, readWhen: b.readWhen, writtenBy: "ai" as const, drawers: { 4: chunk.text }, source: sourceLabel(chunk), sources: [{ ...src(chunk), drawer: 4 }] };
      }),
    );
    placement.componentBoxes.push(...comp);
    r.boxes.forEach((b, i) => {
      const chunkId = pieceBox.get(`${r.name}/${b.name}`);
      if (chunkId && byId.get(chunkId)) placement.chunkToBox[chunkId] = comp[i];
    });
    const mine = notes.filter((c) => pieceRow.get(c.id) === r.name && !inside.includes(c));
    const noteIds = bulkCreate(
      root,
      num,
      mine.map((c) => ({
        name: nameFor(c),
        summary: `${c.title ?? "Note"}${c.part ? ` (part ${c.part.index} of ${c.part.total})` : ""}`,
        readWhen: `Working on anything related to: ${(c.title ?? "").slice(0, 120)}`,
        drawers: { 4: c.text },
        source: sourceLabel(c),
        writtenBy: "migrated",
        sources: [{ ...src(c), drawer: 4 }],
      })),
    );
    placement.noteBoxes.push(...noteIds);
    record(noteIds, mine.map((c) => [c]));
  }
  // Notes that weren't placed (no row structure step): keep them in a notes row.
  const unplaced = notes.filter((c) => !placement.chunkToBox[c.id]);
  if (unplaced.length) {
    const row = createRow(root, { type: "custom", name: "notes", summary: "Notes, plans, and decisions kept from the project's files.", readWhen: "Looking for background on a design, plan, or decision.", writtenBy: "person" });
    placement.rowByName.notes = row.id;
    const ids = bulkCreate(
      root,
      row.num,
      unplaced.map((c) => ({ name: nameFor(c), summary: c.title ?? "Note", readWhen: `Working on anything related to: ${(c.title ?? "").slice(0, 120)}`, drawers: { 4: c.text }, source: sourceLabel(c), writtenBy: "migrated", sources: [{ ...src(c), drawer: 4 }] })),
    );
    placement.noteBoxes.push(...ids);
    record(ids, unplaced.map((c) => [c]));
  }

  // Text between entries → the root Z4 of the row its neighbors went to.
  cube = loadCube(root);
  const glueByRow = new Map<string, Chunk[]>();
  const bySource = new Map<string, Chunk[]>();
  for (const c of chunks) bySource.set(c.source, [...(bySource.get(c.source) ?? []), c]);
  for (const [, list] of bySource) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    sorted.forEach((c, i) => {
      if (c.role !== "glue") return;
      const neighbor = sorted.slice(i + 1).find((x) => x.role === "entry" && x.section === c.section) ?? [...sorted.slice(0, i)].reverse().find((x) => x.role === "entry") ?? sorted.find((x) => x.role === "entry");
      let rowId = rulesRow.id;
      if (neighbor) {
        const boxId = placement.chunkToBox[neighbor.id];
        rowId = boxId ? boxId.split(".")[0] : rulesRow.id;
      } else {
        rowId = c.kind === "history" ? historyRow.id : c.kind === "invariants" ? invRow.id : rulesRow.id;
      }
      glueByRow.set(rowId, [...(glueByRow.get(rowId) ?? []), c]);
    });
  }
  for (const [rowId, glue] of glueByRow) appendGlue(root, getRow(cube, rowId)!, glue.sort((a, b) => a.source.localeCompare(b.source) || a.start - b.start));

  placement.complete = true;
  writeJson(placementPath(root), placement);
  await reindex(root, { adapters: false });
  const c2 = loadCube(root);
  ctx.ask.say(`\nPlaced ${fmtInt(Object.keys(placement.chunkToBox).length)} pieces into ${fmtInt(allBoxes(c2).filter((b) => !b.isRoot).length)} boxes across ${c2.rows.length} rows.`);
}

// ---------- 9b. projects without memory files: history from git, first rules, candidate invariants ----------

async function gitextras(ctx: BuildContext, state: BuildState) {
  const root = ctx.root;
  const { chunks } = loadChunks(root);
  if (!loadPlacement(root)) return;
  const config = loadConfig(root);
  const commits = readCommits(root, config.history.gitCommits);
  const has = (kind: string) => chunks.some((c) => c.kind === kind && c.role === "entry");
  let cube = loadCube(root);

  if (!has("history") && commits.length) {
    const unit =
      config.history.unit ??
      ((await ctx.ask.choose("History will come from git. Each entry is one:", ["day", "commit", "release", "pr", "build", "session"], commits.length > 80 ? "day" : "commit")) as NonNullable<typeof config.history.unit>);
    config.history.unit = unit;
    saveConfig(root, config);
    const groups = groupCommits(commits, unit).slice(-200);
    const row = cube.rows.find((r) => r.type === "history")!;
    const ids = bulkCreate(
      root,
      row.num,
      groups.map((g) => ({
        name: slugify(`${g.key} ${g.commits[g.commits.length - 1].subject}`),
        summary: g.commits[g.commits.length - 1].subject,
        readWhen: `Debugging or changing anything these commits touched (${g.key}).`,
        drawers: { 4: groupDetail(g) },
        source: `git: ${g.commits.length} commit${g.commits.length === 1 ? "" : "s"}, ${g.commits[0].date}${g.commits.length > 1 ? ` to ${g.commits[g.commits.length - 1].date}` : ""}`,
        writtenBy: "migrated" as const,
      })),
    );
    ids.forEach((id, i) => {
      const g = groups[i];
      const st = loadBoxState(root, id)!;
      saveBoxState(root, { ...st, fromGit: true, date: g.date, historyKey: g.key, code: { files: [], commits: g.commits.map((c) => ({ hash: c.hash.slice(0, 8), date: c.date, subject: c.subject, files: c.files })) } });
    });
    ctx.ask.say(`\nBuilt ${ids.length} history entries from ${commits.length} commits (one per ${unit}).`);
    cube = loadCube(root);
  }

  if (!has("rules") && !cube.rows.find((r) => r.type === "rules")!.boxes.length) {
    const facts = projectFacts(root);
    let drafted: InterviewOutput | undefined;
    if (ctx.ask.interactive) drafted = await interview(root, ctx.ask, runCtx(ctx));
    else if (facts) drafted = (await runStep(interviewStep, { answers: [], config: facts }, { ...runCtx(ctx), root, label: "first rules" })).output;
    if (drafted?.rules.length) {
      for (const l of ["", "Drafted rules from the project's config files:", ...drafted.rules.map((r, i) => `  ${i + 1}. ${r.text}`)]) ctx.ask.say(l);
      if (await ctx.ask.confirm("Add these rules?", true)) {
        bulkCreate(root, 0, drafted.rules.map((r) => ({ name: r.name, summary: r.text.slice(0, 200), readWhen: "Always.", body: `${r.text}\n`, writtenBy: "ai" as const })));
      }
    }
  }

  if (!has("invariants")) {
    const evidence = gatherEvidence(root, commits);
    if (hasEvidence(evidence)) {
      ctx.ask.say("\nDrafting candidate invariants from reverted and fix commits and code comments…");
      const r = await runStep(candidatesStep, evidence, { ...runCtx(ctx), root, label: "candidate invariants" });
      for (const c of r.output.candidates) {
        proposeNew(root, {
          name: c.name,
          summary: c.summary,
          readWhen: c.readWhen,
          text: `${c.text.replace(/\n*$/, "")}\n\nEvidence: ${c.evidence.join(", ")}\n`,
          reason: "drafted by the build from git history and code comments; needs a person's review",
        });
      }
      if (r.output.candidates.length) ctx.ask.say(`  ${r.output.candidates.length} candidate${r.output.candidates.length === 1 ? "" : "s"} added, marked pending. Review them with: ${TOOL_COMMAND} pending`);
      state.candidateInvariants = r.output.candidates.length;
    }
  }
  await reindex(root, { adapters: false });
}

// ---------- 10. enrich ----------

function targetsFor(cube: Cube, placement: Placement, withInvariants: boolean): Target[] {
  const out: Target[] = [];
  for (const row of cube.rows) {
    if (row.type === "history") continue;
    if (row.type === "invariants" && !withInvariants) continue;
    const h = row.root?.header;
    out.push({ id: row.id, line: `${row.id} ${row.name} (${row.type} row): ${h?.summary ?? ""}` });
    if (row.type === "rules") continue;
    for (const b of row.boxes) {
      const isComponent = placement.componentBoxes.includes(b.id);
      if (isComponent || (row.type === "invariants" && withInvariants)) out.push({ id: b.id, line: `${b.id} ${b.name}: ${(b.header?.summary ?? "").slice(0, 140)}` });
    }
  }
  return out;
}

function itemsFor(cube: Cube, ids: string[], drawer: number, maxChars: number, ready: Map<string, string>): EnrichItem[] {
  return ids
    .map((id) => getBox(cube, id))
    .filter((b): b is Box => !!b)
    .map((b) => {
      // Own text only: generated sections (backlinks, the "past record" note) are the tool's, not the entry's.
      const text = splitGenerated(readTextOr(join(b.dir, ["Z0-overview.md", "Z1-invariants.md", "Z2-code.md", "Z3-history.md", "Z4-detail.md"][drawer]), "")).own;
      const firstLine = text.split("\n").find((l) => l.trim() && !l.startsWith("<!--")) ?? b.name;
      return { id: b.id, title: firstLine.replace(/^#+\s*/, "").slice(0, 160), text: cut(text.replace(/<!-- cube:(from .*?|end-from) -->\n?/g, ""), maxChars), summary: ready.get(b.id) };
    });
}

function enrichBatches(items: EnrichItem[], budget = 32_000, maxItems = 12): EnrichItem[][] {
  const out: EnrichItem[][] = [];
  let cur: EnrichItem[] = [];
  let used = 0;
  for (const it of items) {
    const s = it.text.length + it.title.length + 200;
    if (cur.length && (used + s > budget || cur.length >= maxItems)) {
      out.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(it);
    used += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function enrich(ctx: BuildContext, state: BuildState) {
  const root = ctx.root;
  const placement = loadPlacement(root);
  if (!placement) return;
  const progressPath = join(buildDir(root), "enrich.json");
  const done = readJsonOr<Record<string, true>>(progressPath, {});
  const parallel = loadConfig(root).ai.parallel;
  let cube = loadCube(root);
  const known = (id: string, targets: Target[]) => targets.some((t) => t.id === id);

  const historyRow = cube.rows.find((r) => r.type === "history")!;
  const invRow = cube.rows.find((r) => r.type === "invariants")!;
  const historyIds = historyRow.boxes.map((b) => b.id);
  // Only migrated invariants need labels; drafted candidates already have them.
  const invIds = invRow.boxes.filter((b) => b.header?.written_by === "migrated").map((b) => b.id);
  const noteIds = placement.noteBoxes;

  // Ready-made summaries from the recipe (e.g. the words after a dash in a heading).
  const { chunks } = loadChunks(root);
  const ready = new Map<string, string>();
  for (const c of chunks) if (c.summary && placement.chunkToBox[c.id]) ready.set(placement.chunkToBox[c.id], c.summary);
  const jobs: { step: "history" | "invariants" | "notes"; items: EnrichItem[]; targets: Target[] }[] = [];
  const histTargets = targetsFor(cube, placement, true);
  const invTargets = targetsFor(cube, placement, false);
  for (const b of enrichBatches(itemsFor(cube, historyIds, 4, 8000, ready))) jobs.push({ step: "history", items: b, targets: histTargets });
  for (const b of enrichBatches(itemsFor(cube, invIds, 1, 9000, ready))) jobs.push({ step: "invariants", items: b, targets: invTargets });
  for (const b of enrichBatches(itemsFor(cube, noteIds, 4, 6000, ready))) jobs.push({ step: "notes", items: b, targets: histTargets });
  const pending = jobs.filter((j) => !j.items.every((i) => done[i.id]));
  if (!pending.length) return;
  ctx.ask.say(`\nWriting summaries and links: ${historyIds.length} history entries, ${invIds.length} invariants topics, ${noteIds.length} note pieces (${pending.length} AI calls)…`);

  let finished = 0;
  await mapLimit(pending, parallel, async (job) => {
    const input: EnrichIn = { targets: job.targets, items: job.items };
    const updates = new Map<string, HeaderUpdate>();
    const extra = new Map<string, Link[]>();
    const rctx = { ...runCtx(ctx), root, label: `${job.step} ${job.items[0].id}…` };
    if (job.step === "history") {
      const r = await runStep(historyStep, input, rctx);
      for (const e of r.output.entries) {
        const touches = e.touches.filter((t) => known(t.to, job.targets));
        updates.set(e.id, {
          name: e.name,
          summary: e.summary,
          readWhen: e.readWhen,
          scope: e.projectWide || !touches.length ? "project-wide" : undefined,
          addLinks: touches.map((t) => ({ to: t.to, rel: "touches", note: t.note })),
          writtenBy: "ai",
        });
      }
    } else if (job.step === "invariants") {
      const r = await runStep(invariantsStep, input, rctx);
      for (const t of r.output.topics) {
        updates.set(t.id, { name: t.name, summary: t.label, readWhen: t.readWhen, scope: t.scope, writtenBy: "ai" });
        for (const g of t.governs.filter((x) => known(x.to, job.targets) && x.to.includes("."))) {
          extra.set(g.to, [...(extra.get(g.to) ?? []), { to: t.id, rel: "governed-by", note: g.note }]);
        }
      }
    } else {
      const r = await runStep(overviewsStep, input, rctx);
      for (const p of r.output.pieces) {
        updates.set(p.id, {
          name: p.name,
          summary: p.summary,
          readWhen: p.readWhen,
          addLinks: (p.links ?? []).filter((l) => known(l.to, job.targets)).map((l) => ({ to: l.to, rel: l.rel, note: l.note })),
          writtenBy: "ai",
        });
      }
    }
    // Writes happen one job at a time (mapLimit's callbacks don't overlap synchronous code).
    bulkUpdateHeaders(root, updates);
    if (extra.size) bulkUpdateHeaders(root, new Map([...extra].map(([id, links]) => [id, { addLinks: links }])));
    for (const i of job.items) done[i.id] = true;
    writeJson(progressPath, done);
    finished++;
    if (finished % 5 === 0 || finished === pending.length) ctx.ask.say(`  ${finished} of ${pending.length} done`);
  });
  cube = loadCube(root);
  void state;
  void cube;
}

// ---------- 11. code links ----------

async function codelinks(ctx: BuildContext, state: BuildState) {
  const root = ctx.root;
  const placement = loadPlacement(root);
  const { chunks } = loadChunks(root);
  const keys = new Map<string, string>();
  if (placement) for (const c of chunks) if (c.key && c.kind === "history" && placement.chunkToBox[c.id]) keys.set(placement.chunkToBox[c.id], c.key);
  const r = linkCode(root, undefined, { keys });
  ctx.ask.say(`\nLinked ${r.withCode} boxes to the code they mention${r.historyWithCommits ? `, and ${r.historyWithCommits} history entries to their commits` : ""} (no AI).`);
  state.codeLinks = r;
}

// ---------- 12. backlinks and aliases ----------

async function backlinks(ctx: BuildContext, state: BuildState) {
  const root = ctx.root;
  const placement = loadPlacement(root);
  const { chunks, refs } = loadChunks(root);
  if (placement) {
    const links = new Map<string, Link[]>();
    const aliases: { alias: string; target: string }[] = [];
    for (const c of chunks) {
      const box = placement.chunkToBox[c.id];
      if (!box || !c.key || (c.part && c.part.index > 1)) continue;
      aliases.push({ alias: c.kind === "invariants" && /^\d/.test(c.key) ? `§${c.key}` : c.key, target: box });
    }
    for (const h of refs) {
      if (!h.target) continue;
      const to = placement.chunkToBox[h.target];
      if (!to) continue;
      aliases.push({ alias: h.text.replace(/^\(|\)$/g, "").trim(), target: to });
      const from = placement.chunkToBox[h.chunk];
      if (!from || from === to) continue;
      const list = links.get(from) ?? [];
      if (!list.some((l) => l.to === to)) list.push({ to, rel: "see-also", note: `mentions ${h.text.trim()}` });
      links.set(from, list);
    }
    const seen = new Set<string>();
    addAliases(
      root,
      aliases.filter((a) => {
        const k = a.alias.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }),
    );
    bulkUpdateHeaders(root, new Map([...links].map(([id, l]) => [id, { addLinks: l }])));
    state.aliases = seen.size;
  }
  await reindex(root, { adapters: false });
}

// ---------- 13. check and coverage ----------

async function check(ctx: BuildContext, state: BuildState) {
  const root = ctx.root;
  const recipe = loadRecipe(root);
  const sources = recipe?.sources.map((s) => s.path) ?? [];
  const cov = placedCoverage(root, sources);
  const bad = cov.filter((c) => !c.ok);
  state.coverage = { sources: cov.length, ok: cov.length - bad.length };
  if (bad.length) {
    for (const b of bad) ctx.ask.say(`  coverage problem in ${b.source}: ${b.problem}`);
    throw new Error("Coverage failed: some source text didn't land in the cube exactly. Nothing was lost from your original files; see the problems above.");
  }
  ctx.ask.say(`\nCoverage: all ${cov.length} source file${cov.length === 1 ? "" : "s"} recombine exactly from the cube (${fmtInt(cov.reduce((n, c) => n + c.lines, 0))} lines).`);
  const issues = await runChecks(root);
  const errors = issues.filter((i) => i.level === "error");
  state.checkErrors = errors.length;
  if (issues.length) ctx.ask.say(renderIssues(issues.filter((i) => i.code !== "index-outdated")));
}

// ---------- 14. spot check ----------

async function spotcheck(ctx: BuildContext, state: BuildState) {
  const root = ctx.root;
  const cube = loadCube(root);
  const ai = allBoxes(cube).filter((b) => !b.isRoot && b.header?.written_by === "ai" && b.header.source);
  const pick = sample(ai, 10);
  if (!pick.length) return;
  const lines = ["# Spot check", "", "Ten boxes with AI-written summaries, next to the text they came from. Check that each summary, read-when line, and link is right.", ""];
  for (const b of pick) {
    const h = b.header!;
    const row = getRow(cube, b.rowNum)!;
    const main = [4, 1, 0].find((z) => b.drawers.some((d) => d.z === z))!;
    const text = readTextOr(join(b.dir, ["Z0-overview.md", "Z1-invariants.md", "", "", "Z4-detail.md"][main]), "");
    lines.push(`## ${b.id} ${b.name} (${row.name})`, "", `- **Summary:** ${h.summary}`, `- **Read when:** ${h.read_when ?? ""}`);
    if (h.scope) lines.push(`- **Scope:** ${h.scope}`);
    for (const l of h.links) lines.push(`- **${l.rel}** ${l.to} ${l.name ?? ""}${l.note ? `: ${l.note}` : ""}`);
    lines.push(`- **From:** ${h.source}`, "", "```text", cut(main === 0 ? text.replace(/^---[\s\S]*?\n---\n/, "") : text, 2500), "```", "");
  }
  const path = join(buildDir(root), "spot-check.md");
  writeText(path, lines.join("\n"));
  ctx.ask.say(`\nSpot check: ${pick.length} random boxes are shown next to their source in\n  ${path}`);
  const answer = await ctx.ask.text("Look them over. Type the ids of any that look wrong, separated by spaces (or press Enter if they all look right):", "");
  const wrong = new Set(answer.split(/[\s,]+/).filter(Boolean).map((s) => s.toUpperCase()));
  const stepOf = (b: Box) => (getRow(cube, b.rowNum)!.type === "history" ? "history-summaries" : getRow(cube, b.rowNum)!.type === "invariants" ? "invariant-labels" : "box-overviews");
  for (const b of pick) recordQuality(root, { kind: wrong.has(b.id) ? "spot-check-fail" : "spot-check-ok", step: stepOf(b), id: b.id });
  state.spotCheck = { shown: pick.length, wrong: [...wrong] };
}

function sample<T>(xs: T[], n: number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// ---------- 15. index and install ----------

async function install(ctx: BuildContext, state: BuildState) {
  const root = ctx.root;
  await reindex(root);
  for (const hook of installHooks) await hook(ctx, state);
  const cube = loadCube(root);
  const since = String(state.startedAt ?? "");
  const calls = readJsonl<AICallLog>(logFiles(root).aiCalls).filter((c) => !since || c.t >= since);
  const bySteps = new Map<string, { in: number; out: number; calls: number }>();
  for (const c of calls) {
    const s = bySteps.get(c.step) ?? { in: 0, out: 0, calls: 0 };
    s.in += c.tokensIn;
    s.out += c.tokensOut;
    s.calls++;
    bySteps.set(c.step, s);
  }
  const total = [...bySteps.values()].reduce((n, s) => n + s.in + s.out, 0);
  ctx.ask.say("");
  ctx.ask.say(`Done. The cube has ${cube.rows.length} rows and ${fmtInt(allBoxes(cube).filter((b) => !b.isRoot).length)} boxes: context-cube/CUBE.md`);
  if (state.coverage) ctx.ask.say(`Every line of your ${(state.coverage as any).sources} source files is in the cube, word for word. Your original files weren't changed.`);
  if (total) {
    ctx.ask.say(`AI tokens used by this build: ${fmtInt(total)}${[...bySteps].length ? ` (${[...bySteps].map(([s, v]) => `${s} ${fmtInt(v.in + v.out)}`).join(", ")})` : ""}.`);
  }
}

/** Install work after indexing: hooks (and, from later phases, permissions and the updater). */
export const installHooks: ((ctx: BuildContext, s: BuildState) => Promise<void>)[] = [
  async (ctx) => {
    for (const line of await installAgents(ctx.root)) ctx.ask.say(line);
  },
];

export function buildStages(): Partial<Record<Stage, (ctx: BuildContext, s: BuildState) => Promise<void>>> {
  return { rows, review, place, gitextras, enrich, codelinks, backlinks, check, spotcheck, install };
}

export { loadPlacement, proposalPath };
