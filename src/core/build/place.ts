import { join } from "node:path";
import { ensureDir, readTextOr, writeText } from "../fsutil";
import { getRow, loadCube, type Row } from "../cube";
import { boxDirName, boxId, widthFor } from "../format/ids";
import { DRAWERS, type Writer } from "../format/drawers";
import { renderDoc, type Header } from "../format/header";
import { slugify } from "../format/names";
import { nextBoxNum, repadRow, touchState, oneLine } from "../ops";
import { saveBoxState, type BoxState } from "../state/state";
import type { Chunk } from "./split";
import type { Recipe } from "./recipe";

/**
 * Place (pipeline step 9): every chunk goes to exactly one drawer, word for
 * word. Rules → the rules row's Z0 bodies, history → the history row's Z4 (in
 * time order, oldest first), invariants → the invariants row's Z1, notes and
 * catalog pieces → the rows the AI chose, as Z4. Text between entries goes to
 * the root Z4 of its row, each piece wrapped in markers so it recombines.
 */

export const FROM_START = (file: string, start: number, end: number) => `<!-- cube:from ${file} L${start}-L${end} -->`;
export const FROM_END = "<!-- cube:end-from -->";
export const FROM_RE = /<!-- cube:from (.+?) L(\d+)-L(\d+) -->\n([\s\S]*?)<!-- cube:end-from -->\n?/g;

export function wrapPiece(c: { source: string; start: number; end: number; text: string }): string {
  return `${FROM_START(c.source, c.start, c.end)}\n${c.text}${FROM_END}\n`;
}

export interface BoxSpec {
  name: string;
  summary: string;
  readWhen: string;
  body?: string;
  drawers?: Partial<Record<number, string>>;
  source?: string;
  writtenBy: Writer;
  sources?: BoxState["sources"];
  chunks?: string[];
}

/** Creates many boxes in one row at once (numbers assigned in order). Returns their ids. */
export function bulkCreate(root: string, rowNum: number, specs: BoxSpec[]): string[] {
  if (!specs.length) return [];
  let row = getRow(loadCube(root), rowNum)!;
  const first = nextBoxNum(row, root);
  const last = first + specs.length - 1;
  if (widthFor(last) > row.width) {
    repadRow(root, row, widthFor(last));
    row = getRow(loadCube(root), rowNum)!;
  }
  const width = Math.max(row.width, widthFor(last));
  const ids: string[] = [];
  specs.forEach((s, i) => {
    const num = first + i;
    const id = boxId(row.num, num, width);
    const name = slugify(s.name);
    const dir = join(row.dir, boxDirName(num, name, width));
    ensureDir(dir);
    const header: Header = {
      id,
      name,
      summary: oneLine(s.summary).slice(0, 400) || name,
      read_when: oneLine(s.readWhen) || undefined,
      links: [],
      status: "ok",
      source: s.source,
      written_by: s.writtenBy,
    };
    writeText(join(dir, "Z0-overview.md"), renderDoc(header, s.body ?? ""));
    for (const [z, text] of Object.entries(s.drawers ?? {})) {
      if (text) writeText(join(dir, DRAWERS[Number(z)].file), text);
    }
    const st = touchState(root, id, dir);
    if (s.sources?.length) {
      st.sources = s.sources;
      saveBoxState(root, st);
    }
    ids.push(id);
  });
  return ids;
}

/** Appends pieces of text-between-entries to a row's root Z4, wrapped in markers. */
export function appendGlue(root: string, row: Row, glue: Chunk[]): void {
  if (!glue.length || !row.root) return;
  const path = join(row.root.dir, "Z4-detail.md");
  const before = readTextOr(path, "");
  const header = before ? "" : "Text kept word for word from the original files, between the entries that became boxes.\n\n";
  writeText(path, before + header + glue.map(wrapPiece).join(""));
  const st = touchState(root, row.root.id, row.root.dir);
  st.sources = [...(st.sources ?? []), ...glue.map((g) => ({ file: g.source, start: g.start, end: g.end, drawer: 4, wrapped: true }))];
  saveBoxState(root, st);
}

// ---------- history order ----------

/**
 * History rows number forward in time (plan 3.1): oldest X001. Entries are put
 * in time order within each source (reversing newest-first files), then all
 * sources are merged by date. Entries without a date take the date of the
 * nearest earlier entry in the same file.
 */
export function chronological(entries: Chunk[], recipe: Recipe): Chunk[] {
  const bySection = new Map<string, Chunk[]>();
  for (const c of entries) bySection.set(`${c.source}#${c.section}`, [...(bySection.get(`${c.source}#${c.section}`) ?? []), c]);
  const lists: { items: Chunk[]; eff: (string | undefined)[]; order: number }[] = [];
  let order = 0;
  for (const [key, list] of bySection) {
    const [source, sec] = [key.slice(0, key.lastIndexOf("#")), Number(key.slice(key.lastIndexOf("#") + 1))];
    const sr = recipe.sources.find((s) => s.path === source);
    const section = sr ? [...sr.sections].sort((a, b) => a.startLine - b.startLine)[sec] : undefined;
    let items = [...list].sort((a, b) => a.start - b.start);
    const dated = items.filter((c) => c.date);
    const declared = section?.order;
    const newestFirst = declared ? declared === "newest-first" : dated.length >= 2 && dated[0].date! > dated[dated.length - 1].date!;
    if (newestFirst) items = items.reverse();
    const eff: (string | undefined)[] = [];
    let last: string | undefined;
    // Dates never go backwards within a file, so the file's own order always wins
    // (an undated entry, or one dated by a later deploy, stays where the file put it).
    for (const c of items) {
      if (c.date && (!last || c.date > last)) last = c.date;
      eff.push(last);
    }
    // Leading undated entries take the first date that follows them.
    const firstDate = eff.find(Boolean);
    for (let i = 0; i < eff.length && !eff[i]; i++) eff[i] = firstDate;
    lists.push({ items, eff, order: order++ });
  }
  const flat = lists.flatMap((l) => l.items.map((c, i) => ({ c, date: l.eff[i] ?? "", order: l.order, i })));
  flat.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order || a.i - b.i));
  lastEffective = new Map(flat.map((x) => [x.c.id, x.date || undefined]));
  return flat.map((x) => x.c);
}

/** The effective dates from the last chronological() call (chunk id → YYYY-MM-DD). */
let lastEffective = new Map<string, string | undefined>();
export function effectiveDate(chunkId: string): string | undefined {
  return lastEffective.get(chunkId);
}

export function sourceLabel(c: Chunk): string {
  const t = (c.title ?? "").slice(0, 80).replace(/"/g, "'");
  return `${c.source} L${c.start}-L${c.end}${t ? `, "${t}"` : ""}`;
}

export function nameFor(c: Chunk): string {
  const base = c.summary && (c.title ?? "").length > 50 ? c.summary : c.title ?? c.summary ?? "entry";
  return slugify(base.replace(/^§\s*/, "s"));
}
