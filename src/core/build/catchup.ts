import { join } from "node:path";
import { readTextOr, writeText } from "../fsutil";
import { allBoxes, getRow, loadCube, type Box, type Cube } from "../cube";
import { DRAWERS } from "../format/drawers";
import { loadBoxState, saveBoxState } from "../state/state";
import { createRow } from "../ops";
import { approveText } from "../approvals";
import { splitLines } from "./markdown";
import { splitSource, type Chunk } from "./split";
import { loadRecipe, saveRecipe, type SourceRecipe } from "./recipe";
import { readSource } from "./sources";
import { appendGlue, bulkCreate, nameFor, sourceLabel } from "./place";
import { loadChunks, saveChunks } from "./pipeline";

/**
 * A source file that changed after the build read it: the build paused at a
 * usage limit, or waited until night, and the person kept working. The build
 * keeps what it read. When the change only adds whole new entries (a new
 * history section, a new note), this brings them in: a box for each, and every
 * later piece of the file moved down to where its lines are now, so the cube
 * still recombines the file exactly and it can be archived. Any other change
 * (text edited or removed, or lines added inside an entry) is left for a
 * person: the cube keeps the file as it was read, and it isn't archived.
 */

export interface CaughtUp {
  source: string;
  /** Boxes made for the new entries. */
  added: string[];
  /** The new lines, where they are now, with the first entry's title. */
  ranges: { start: number; end: number; title?: string }[];
}

export interface Drifted {
  source: string;
  problem: string;
}

/** The text the build read, from its saved pieces; undefined if they don't cover it. */
export function readText(chunks: Chunk[], source: string): string | undefined {
  const mine = chunks.filter((c) => c.source === source).sort((a, b) => a.start - b.start);
  let next = 1;
  for (const c of mine) {
    if (c.start !== next) return undefined;
    next = c.end + 1;
  }
  return mine.map((c) => c.text).join("");
}

/**
 * Which current lines were added, if the text read is still there, in order,
 * with only lines added. Undefined when a line read was changed or removed.
 */
export function addedLines(old: string[], cur: string[]): boolean[] | undefined {
  if (old.length > cur.length) return undefined;
  const added = new Array<boolean>(cur.length).fill(true);
  let pre = 0;
  while (pre < old.length && old[pre] === cur[pre]) added[pre++] = false;
  let suf = 0;
  while (suf < old.length - pre && old[old.length - 1 - suf] === cur[cur.length - 1 - suf]) added[cur.length - 1 - suf++] = false;
  let j = pre;
  for (let i = pre; i < old.length - suf; i++) {
    while (j < cur.length - suf && cur[j] !== old[i]) j++;
    if (j >= cur.length - suf) return undefined;
    added[j++] = false;
  }
  return added;
}

/** Runs of added lines, 0-based and inclusive. */
function runs(added: boolean[]): { a: number; b: number }[] {
  const out: { a: number; b: number }[] = [];
  for (let i = 0; i < added.length; i++) {
    if (!added[i]) continue;
    const a = i;
    while (i + 1 < added.length && added[i + 1]) i++;
    out.push({ a, b: i });
  }
  return out;
}

/** Old line (1-based) → where it is now (1-based). */
function positions(added: boolean[]): number[] {
  const pos = [0];
  added.forEach((isNew, i) => {
    if (!isNew) pos.push(i + 1);
  });
  return pos;
}

/**
 * The places one run of added lines could be, all giving the same text: a run
 * whose first line equals the line after it can slide down one, and one whose
 * last line equals the line before it can slide up (a blank line before or
 * after a new section is the usual case). Nearest first.
 */
function slides(added: boolean[], cur: string[], run: { a: number; b: number }): { v: boolean[]; a: number; b: number; d: number }[] {
  const out = [{ v: added, a: run.a, b: run.b, d: 0 }];
  for (const dir of [1, -1] as const) {
    let { a, b } = run;
    let v = added;
    for (let d = 1; d <= 20; d++) {
      const to = dir === 1 ? b + 1 : a - 1;
      const from = dir === 1 ? a : b;
      if (to < 0 || to >= cur.length || v[to] || cur[to] !== cur[from]) break;
      v = [...v];
      v[from] = false;
      v[to] = true;
      a += dir;
      b += dir;
      out.push({ v, a, b, d });
    }
  }
  return out.sort((x, y) => x.d - y.d);
}

/** The recipe for the file as it is now: each section starts where its first line moved to (or where the caller says). */
function shiftRecipe(sr: SourceRecipe, pos: number[], starts: Map<number, number>): SourceRecipe {
  return { ...sr, sections: sr.sections.map((s) => ({ ...s, startLine: s.startLine === 1 ? 1 : starts.get(s.startLine) ?? pos[s.startLine] ?? s.startLine })) };
}

interface Plan {
  added: boolean[];
  recipe: SourceRecipe;
  /** The new pieces, as they are in the file now. */
  pieces: Chunk[];
  /** Placed pieces (old coordinates) that end in blank lines the new text now follows: they keep lines up to `keepEnd`. */
  trims: { start: number; end: number; keepEnd: number }[];
}

const blank = (l: string | undefined) => l !== undefined && l.trim() === "";

/** A way to read the change as whole new pieces, or a reason it can't be. */
function planFor(sr: SourceRecipe, oldText: string, curText: string, placed: { start: number; end: number }[]): Plan | string {
  const old = splitLines(oldText);
  const cur = splitLines(curText);
  let added = addedLines(old, cur);
  if (!added) return "text the build read was changed or removed, not only added to";
  const starts = new Map<number, number>();
  const pieces: Chunk[] = [];
  const trims: Plan["trims"] = [];
  // Settle each run of added lines where the file's own splitting makes it whole pieces.
  for (const run0 of runs(added)) {
    let found: { v: boolean[]; piecesHere: Chunk[]; trim?: Plan["trims"][number]; sectionStart?: number; a: number } | undefined;
    for (const { v, a, b } of slides(added, cur, run0)) {
      // The old line the run comes after. A placed piece stays whole, except that
      // blank lines at its end may follow the new text instead (they're the gap before what comes next).
      const after = v.slice(0, a).filter((x) => !x).length;
      const inside = placed.find((p) => p.start <= after && after < p.end);
      if (inside && !old.slice(after, inside.end).every(blank)) continue;
      const moved = inside ? inside.end - after : 0;
      const end = b + moved; // 0-based, inclusive: the run plus the blank lines that now follow it
      const lead = cur.slice(a, b + 1).findIndex((l) => !blank(l));
      if (lead < 0) continue; // only blank lines added: nothing to place as an entry
      const pos = positions(v);
      // Added lines right before a section's first line may belong to either section.
      const choices: (number | undefined)[] = [undefined, ...(sr.sections.some((x) => x.startLine === after + 1 && x.startLine !== 1) ? [after + 1] : [])];
      for (const sectionStart of choices) {
        const tryStarts = new Map(starts);
        if (sectionStart) tryStarts.set(sectionStart, a + 1);
        const chunks = splitSource(shiftRecipe(sr, pos, tryStarts), curText);
        const from = a + lead + 1;
        const here = chunks.filter((c) => c.end >= from && c.start <= end + 1);
        if (!here.length || here[0].start !== from || here[here.length - 1].end !== end + 1 || here.some((c) => c.end > end + 1)) continue;
        // Leading blank lines of the run go with its first piece.
        const first = { ...here[0], start: a + 1, text: `${cur.slice(a, from - 1).map((l) => `${l}\n`).join("")}${here[0].text}` };
        first.id = `${first.source}#L${first.start}`;
        found = { v, piecesHere: [first, ...here.slice(1)], trim: inside ? { ...inside, keepEnd: after } : undefined, sectionStart, a };
        break;
      }
      if (found) break;
    }
    if (!found) return `lines ${run0.a + 1}–${run0.b + 1} were added inside an entry the build already placed, not as a new one`;
    added = found.v;
    if (found.sectionStart) starts.set(found.sectionStart, found.a + 1);
    pieces.push(...found.piecesHere);
    if (found.trim) trims.push(found.trim);
  }
  return { added, recipe: shiftRecipe(sr, positions(added), starts), pieces, trims };
}

function boxesWithSource(cube: Cube, source: string): { box: Box; pieces: NonNullable<ReturnType<typeof loadBoxState>>["sources"] }[] {
  return allBoxes(cube)
    .map((box) => ({ box, pieces: (loadBoxState(cube.root, box.id)?.sources ?? []).filter((s) => s.file === source) }))
    .filter((x) => x.pieces?.length);
}

/**
 * Brings in text added to the build's sources since it read them, where it can.
 * Returns what it brought in and the sources it couldn't.
 */
export function catchUp(root: string): { caught: CaughtUp[]; drifted: Drifted[] } {
  const recipe = loadRecipe(root);
  const saved = loadChunks(root);
  const out = { caught: [] as CaughtUp[], drifted: [] as Drifted[] };
  if (!recipe || !saved.chunks.length) return out;
  let chunks = saved.chunks;
  for (const sr of recipe.sources) {
    const read = readText(chunks, sr.path);
    const now = readSource(root, sr.path);
    if (read === undefined || splitLines(read).join("\n") === splitLines(now).join("\n")) continue;
    const cube = loadCube(root);
    const holders = boxesWithSource(cube, sr.path);
    const plan = planFor(sr, read, now, holders.flatMap((h) => h.pieces!));
    if (typeof plan === "string") {
      out.drifted.push({ source: sr.path, problem: plan });
      continue;
    }
    const pos = positions(plan.added);
    const trimOf = (st: number) => plan.trims.find((t) => t.start === st);
    const oldChunk = (st: number) => chunks.find((c) => c.source === sr.path && c.start === st);
    // What the build has read of this file becomes the file as it is: check that first, before changing anything.
    const shifted = chunks
      .filter((c) => c.source === sr.path)
      .map((c) => {
        const t = trimOf(c.start);
        const text = t ? `${splitLines(c.text).slice(0, t.keepEnd - c.start + 1).join("\n")}\n` : c.text;
        return { ...c, id: `${c.source}#L${pos[c.start]}`, start: pos[c.start], end: pos[t ? t.keepEnd : c.end], text };
      });
    const rebuilt = readText([...shifted, ...plan.pieces], sr.path);
    if (rebuilt === undefined || splitLines(rebuilt).join("\n") !== splitLines(now).join("\n")) {
      out.drifted.push({ source: sr.path, problem: "the new text couldn't be fitted between the entries already placed" });
      continue;
    }
    // Every piece already placed moves down to where its lines are now; markers say so too.
    for (const { box, pieces } of holders) {
      const st = loadBoxState(root, box.id)!;
      const moved = new Map<string, { start: number; end: number; trimmed?: { from: string; to: string } }>();
      st.sources = st.sources!.map((s) => {
        if (s.file !== sr.path) return s;
        const t = trimOf(s.start);
        const next = { ...s, start: pos[s.start], end: pos[t ? t.keepEnd : s.end] };
        const text = oldChunk(s.start)?.text;
        const trimmed = t && text !== undefined ? { from: text, to: `${splitLines(text).slice(0, t.keepEnd - s.start + 1).join("\n")}\n` } : undefined;
        if (next.start !== s.start || next.end !== s.end || trimmed) moved.set(`${s.drawer}|${s.start}|${s.end}`, { start: next.start, end: next.end, trimmed });
        return next;
      });
      for (const z of new Set(pieces!.map((s) => s.drawer))) {
        const path = join(box.dir, DRAWERS[z].file);
        const text = readTextOr(path, "");
        let next = text.replace(/<!-- cube:from (.+?) L(\d+)-L(\d+) -->\n([\s\S]*?)<!-- cube:end-from -->/g, (m, file: string, a: string, b: string, inner: string) => {
          const to = file === sr.path ? moved.get(`${z}|${a}|${b}`) : undefined;
          if (!to) return m;
          const body = to.trimmed && inner === to.trimmed.from ? to.trimmed.to : inner;
          return `<!-- cube:from ${file} L${to.start}-L${to.end} -->\n${body}<!-- cube:end-from -->`;
        });
        // A piece stored bare starts its drawer (after the header, for Z0).
        for (const s of pieces!.filter((x) => x.drawer === z && !x.wrapped)) {
          const t = moved.get(`${z}|${s.start}|${s.end}`)?.trimmed;
          if (!t) continue;
          const at = next.indexOf(t.from);
          if (at >= 0) next = next.slice(0, at) + t.to + next.slice(at + t.from.length);
        }
        if (next !== text) {
          writeText(path, next);
          // The tool changed only line numbers, or blank lines at a piece's end, during the build; the next index marks the drawer again.
          if (st.records?.[`Z${z}`]) delete st.records[`Z${z}`];
        }
      }
      saveBoxState(root, st);
    }
    recipe.sources = recipe.sources.map((s) => (s.path === sr.path ? plan.recipe : s));
    saveRecipe(root, recipe);

    const caught: CaughtUp = { source: sr.path, added: [], ranges: plan.pieces.filter((c) => c.role === "entry").map((c) => ({ start: c.start, end: c.end, title: c.title })) };
    caught.added.push(...place(root, plan.pieces, holders));
    out.caught.push(caught);
    chunks = [...chunks.filter((c) => c.source !== sr.path), ...shifted, ...plan.pieces];
    saveChunks(root, chunks, saved.refs);
  }
  return out;
}

/** Makes boxes for new pieces, as the build's place step would, next to where the file's neighbors went. */
function place(root: string, pieces: Chunk[], holders: { box: Box }[]): string[] {
  let cube = loadCube(root);
  const row = (type: string) => cube.rows.find((r) => r.type === type)!;
  const src = (c: Chunk) => ({ file: c.source, start: c.start, end: c.end });
  // The row of the piece placed just before (or else after) a new one, for notes and glue.
  const placedAt = holders.flatMap(({ box }) =>
    (loadBoxState(root, box.id)?.sources ?? []).filter((s) => s.file === pieces[0]?.source).map((s) => ({ start: s.start, row: box.id.split(".")[0], isRoot: box.isRoot })),
  );
  const neighborRow = (c: Chunk, types: string[]): string | undefined => {
    const ok = (id: string) => types.includes(getRow(cube, id)?.type ?? "");
    const before = placedAt.filter((p) => p.start < c.start && ok(p.row)).sort((a, b) => b.start - a.start)[0];
    const after = placedAt.filter((p) => p.start > c.start && ok(p.row)).sort((a, b) => a.start - b.start)[0];
    return (before ?? after)?.row;
  };
  const ids: string[] = [];
  const entries = pieces.filter((c) => c.role === "entry");

  const rules = entries.filter((c) => c.kind === "rules");
  ids.push(...bulkCreate(root, row("rules").num, rules.map((c) => ({ name: nameFor(c), summary: (c.title ?? "").slice(0, 200), readWhen: "Always.", body: c.text, source: sourceLabel(c), writtenBy: "migrated" as const, sources: [{ ...src(c), drawer: 0 }] }))));

  // History parts of one entry stay in one box, as in the place step.
  const groups: Chunk[][] = [];
  for (const c of entries.filter((x) => x.kind === "history")) {
    const last = groups[groups.length - 1];
    if (c.part && c.part.index > 1 && last && last[0].part?.of === c.part.of) last.push(c);
    else groups.push([c]);
  }
  const hist = bulkCreate(
    root,
    row("history").num,
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
  hist.forEach((id, i) => {
    const c = groups[i][0];
    const st = loadBoxState(root, id);
    // Added after everything else the build read, so it's at least as recent as the newest entry.
    const newest = cube.rows.find((r) => r.type === "history")!.boxes.map((b) => loadBoxState(root, b.id)?.date).filter(Boolean).sort().pop();
    const date = c.date ?? newest;
    if (st && (date || c.key)) saveBoxState(root, { ...st, ...(date ? { date } : {}), ...(c.key ? { historyKey: c.key } : {}) });
  });
  ids.push(...hist);

  const inv = entries.filter((c) => c.kind === "invariants");
  const invIds = bulkCreate(root, row("invariants").num, inv.map((c) => ({ name: nameFor(c), summary: c.summary ?? c.title ?? "Invariants topic", readWhen: `Before changing anything covered by: ${(c.title ?? "").slice(0, 120)}`, drawers: { 1: c.text }, source: sourceLabel(c), writtenBy: "migrated" as const, sources: [{ ...src(c), drawer: 1 }] })));
  invIds.forEach((id, i) => approveText(root, id, inv[i].text));
  ids.push(...invIds);

  const notes = entries.filter((c) => c.kind === "notes" || c.kind === "catalog");
  for (const c of notes) {
    let rowId = neighborRow(c, ["feature", "system", "catalog", "custom"]);
    if (!rowId) {
      rowId = cube.rows.find((r) => r.type === "custom" && r.name === "notes")?.id ?? createRow(root, { type: "custom", name: "notes", summary: "Notes, plans, and decisions kept from the project's files.", readWhen: "Looking for background on a design, plan, or decision.", writtenBy: "person" }).id;
      cube = loadCube(root);
    }
    ids.push(...bulkCreate(root, getRow(cube, rowId)!.num, [{ name: nameFor(c), summary: c.title ?? "Note", readWhen: `Working on anything related to: ${(c.title ?? "").slice(0, 120)}`, drawers: { 4: c.text }, source: sourceLabel(c), writtenBy: "migrated" as const, sources: [{ ...src(c), drawer: 4 }] }]));
  }

  // Text between new entries goes to the root Z4 of the row its neighbors are in.
  cube = loadCube(root);
  for (const g of pieces.filter((c) => c.role === "glue")) {
    const kindRow = g.kind === "history" ? row("history").id : g.kind === "invariants" ? row("invariants").id : g.kind === "rules" ? row("rules").id : undefined;
    const rowId = kindRow ?? neighborRow(g, ["feature", "system", "catalog", "custom"]) ?? row("rules").id;
    appendGlue(root, getRow(cube, rowId)!, [g]);
  }
  return ids;
}
