import { renameSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, exists, readTextOr, remove, writeText } from "./fsutil";
import { cubePaths } from "./paths";
import { boxDirName, boxId, idKey, parseId, rowDirName, rowId, widthFor } from "./format/ids";
import { DRAWERS, type LinkRel, type RowType, type Status, type Writer } from "./format/drawers";
import { parseDoc, renderDoc, type Header, type Link } from "./format/header";
import { isValidName, slugify } from "./format/names";
import { joinGenerated, splitGenerated } from "./format/generated";
import { rewriteInlineRefs } from "./format/links";
import { allBoxes, canonicalId, drawerPath, getBox, getRow, loadCube, type Box, type Cube, type Row } from "./cube";
import {
  addAliases,
  loadBoxState,
  loadRetired,
  newBoxState,
  removeBoxState,
  retire,
  saveBoxState,
  sha,
  boxStatePath,
  type BoxState,
} from "./state/state";

export class CubeError extends Error {}

// ---------- numbering ----------

export function nextRowNum(cube: Cube, root: string): number {
  let max = 0;
  for (const r of cube.allRows) max = Math.max(max, r.num);
  for (const r of loadRetired(root)) {
    const c = parseId(r.id);
    if (c && c.box === undefined) max = Math.max(max, c.row);
  }
  const n = max + 1;
  if (n > 99) throw new CubeError("The cube already has 99 rows; no row numbers are left.");
  return n;
}

export function nextBoxNum(row: Row, root: string): number {
  let max = 0;
  for (const b of row.allBoxes) max = Math.max(max, b.num);
  for (const r of loadRetired(root)) {
    const c = parseId(r.id);
    if (c && c.row === row.num && c.box !== undefined) max = Math.max(max, c.box);
  }
  return max + 1;
}

// ---------- names ----------

export function toName(input: string): string {
  const n = isValidName(input) ? input : slugify(input);
  if (!isValidName(n)) throw new CubeError(`"${input}" can't be used as a name. Use 1–5 lowercase words joined by hyphens.`);
  return n;
}

// ---------- rows ----------

export interface NewRowInput {
  type: RowType;
  name: string;
  summary: string;
  readWhen: string;
  conventions?: string[];
  body?: string;
  /** Only the rules row may ask for a specific number (0). */
  num?: number;
  writtenBy?: Writer;
  drawers?: Partial<Record<1 | 2 | 3 | 4, string>>;
}

export function createRow(root: string, input: NewRowInput): Row {
  const cube = loadCube(root);
  let num: number;
  if (input.type === "rules") {
    if (getRow(cube, 0)) throw new CubeError("The cube already has a rules row (Y00). There is only one.");
    num = 0;
  } else {
    if (input.num !== undefined) throw new CubeError("Only the tool assigns row numbers.");
    num = nextRowNum(cube, root);
  }
  const name = toName(input.name);
  const dir = join(cubePaths(root).cube, rowDirName(num, name));
  ensureDir(dir);
  const header: Header = {
    id: boxId(num, 0),
    name,
    summary: oneLine(input.summary),
    read_when: oneLine(input.readWhen),
    row_type: input.type,
    conventions: input.conventions?.length ? input.conventions : undefined,
    links: [],
    status: "ok",
    written_by: input.writtenBy ?? "person",
  };
  const rootDir = join(dir, boxDirName(0, "root"));
  ensureDir(rootDir);
  writeText(join(rootDir, "Z0-overview.md"), renderDoc(header, ensureNl(input.body ?? "")));
  for (const [z, text] of Object.entries(input.drawers ?? {})) {
    if (text) writeText(join(rootDir, DRAWERS[Number(z)].file), ensureNl(text));
  }
  touchState(root, header.id, rootDir);
  return getRow(loadCube(root), num)!;
}

// ---------- boxes ----------

export interface NewBoxInput {
  name: string;
  summary: string;
  readWhen?: string;
  body?: string;
  drawers?: Partial<Record<1 | 2 | 3 | 4, string>>;
  links?: Link[];
  status?: Status;
  source?: string;
  writtenBy?: Writer;
  sources?: BoxState["sources"];
  /** Only used when rebuilding with numbers the tool assigned earlier (e.g. merges). */
  forceNum?: number;
}

export function createBox(root: string, rowRef: string | number, input: NewBoxInput): Box {
  let cube = loadCube(root);
  let row = getRow(cube, rowRef);
  if (!row) throw new CubeError(`No row ${rowRef}. See the row list in context-cube/CUBE.md.`);
  const num = input.forceNum ?? nextBoxNum(row, root);
  if (widthFor(num) > row.width) {
    repadRow(root, row, widthFor(num));
    cube = loadCube(root);
    row = getRow(cube, row.num)!;
  }
  const name = toName(input.name);
  const id = boxId(row.num, num, row.width);
  const dir = join(row.dir, boxDirName(num, name, row.width));
  if (exists(dir)) throw new CubeError(`${id} already exists.`);
  ensureDir(dir);
  const links = (input.links ?? []).map((l) => withLinkName(cube, l));
  const header: Header = {
    id,
    name,
    summary: oneLine(input.summary),
    read_when: input.readWhen ? oneLine(input.readWhen) : undefined,
    links,
    status: input.status ?? "ok",
    source: input.source,
    written_by: input.writtenBy ?? "person",
  };
  writeText(join(dir, "Z0-overview.md"), renderDoc(header, ensureNl(input.body ?? "")));
  for (const [z, text] of Object.entries(input.drawers ?? {})) {
    if (text !== undefined && text !== "") writeText(join(dir, DRAWERS[Number(z)].file), text);
  }
  const st = touchState(root, id, dir);
  if (input.sources) {
    st.sources = input.sources;
    saveBoxState(root, st);
  }
  return getBox(loadCube(root), id)!;
}

function withLinkName(cube: Cube, l: Link): Link {
  const target = getBox(cube, l.to) ?? (parseId(l.to)?.box === undefined ? getRow(cube, l.to)?.root : undefined);
  const to = canonicalId(cube, l.to) ?? l.to;
  return { to, name: target ? targetName(cube, target) : l.name, rel: l.rel, note: l.note };
}

/** A link's display name: the box's name, or the row's name for a row (its root box). */
export function targetName(cube: Cube, target: Box): string {
  return target.isRoot ? getRow(cube, target.rowNum)?.name ?? target.name : target.name;
}

/** Rewrites a box's Z0 header and body. */
export function updateZ0(root: string, id: string, fn: (h: Header, body: string) => { header: Header; body: string }): Box {
  const cube = loadCube(root);
  const box = getBox(cube, id);
  if (!box) throw new CubeError(`No box ${id}.`);
  const text = readTextOr(drawerPath(box, 0), "");
  const doc = parseDoc(text);
  if (!doc.header) throw new CubeError(`${box.id} has an invalid header (${doc.error}). Fix it by hand, then try again.`);
  const { own, generated } = splitGenerated(doc.body);
  const next = fn(structuredClone(doc.header), own);
  writeText(drawerPath(box, 0), renderDoc(next.header, joinGenerated(next.body, generated)));
  touchState(root, box.id, box.dir);
  return getBox(loadCube(root), box.id)!;
}

/** Writes a drawer's own text, keeping its generated section. Empty text removes the drawer. */
export function writeDrawer(root: string, id: string, z: number, text: string): void {
  if (z === 0) throw new CubeError("Use updateZ0 for Z0.");
  const cube = loadCube(root);
  const box = getBox(cube, id);
  if (!box) throw new CubeError(`No box ${id}.`);
  const path = drawerPath(box, z);
  const { generated } = splitGenerated(readTextOr(path, ""));
  const next = joinGenerated(text, generated);
  if (next === "") remove(path);
  else writeText(path, next);
  touchState(root, box.id, box.dir);
}

export function addLink(root: string, fromId: string, to: string, rel: LinkRel, note?: string): Link {
  const cube = loadCube(root);
  const from = getBox(cube, fromId);
  if (!from) throw new CubeError(`No box ${fromId}.`);
  const target = getBox(cube, to);
  const targetRow = getRow(cube, to);
  if (!target && !(targetRow && parseId(to)?.box === undefined)) throw new CubeError(`No box or row ${to}.`);
  const link = withLinkName(cube, { to, rel, note });
  updateZ0(root, from.id, (h, body) => {
    const links = h.links.filter((l) => !(idKey(l.to) === idKey(link.to) && l.rel === link.rel));
    links.push(link);
    return { header: { ...h, links }, body };
  });
  return link;
}

export function removeLink(root: string, fromId: string, to: string, rel?: LinkRel): number {
  let removed = 0;
  updateZ0(root, fromId, (h, body) => {
    const links = h.links.filter((l) => {
      const match = idKey(l.to) === idKey(to) && (!rel || l.rel === rel);
      if (match) removed++;
      return !match;
    });
    return { header: { ...h, links }, body };
  });
  return removed;
}

// ---------- rename, move, delete ----------

export function renameBox(root: string, id: string, newName: string): Box {
  const cube = loadCube(root);
  const box = getBox(cube, id);
  if (!box) throw new CubeError(`No box ${id}.`);
  if (box.isRoot) return renameRow(root, box.rowNum, newName).root!;
  const name = toName(newName);
  const row = getRow(cube, box.rowNum)!;
  const dir = join(row.dir, boxDirName(box.num, name, row.width));
  if (dir !== box.dir) renameSync(box.dir, dir);
  updateZ0(root, box.id, (h, body) => ({ header: { ...h, name }, body }));
  syncLinkNames(root);
  return getBox(loadCube(root), box.id)!;
}

export function renameRow(root: string, ref: string | number, newName: string): Row {
  const cube = loadCube(root);
  const row = getRow(cube, ref);
  if (!row) throw new CubeError(`No row ${ref}.`);
  const name = toName(newName);
  const dir = join(cubePaths(root).cube, rowDirName(row.num, name));
  if (dir !== row.dir) renameSync(row.dir, dir);
  if (row.root) updateZ0(root, row.root.id, (h, body) => ({ header: { ...h, name }, body }));
  return getRow(loadCube(root), row.num)!;
}

/**
 * Moves a box to another row (or renumbers it in its own row): new number,
 * every link and inline reference rewritten, an alias recorded, the old
 * number retired.
 */
export function moveBox(root: string, id: string, toRowRef: string | number): { from: string; to: string } {
  const cube = loadCube(root);
  const box = getBox(cube, id);
  if (!box) throw new CubeError(`No box ${id}.`);
  if (box.isRoot) throw new CubeError("A row's root box can't be moved.");
  const toRow = getRow(cube, toRowRef);
  if (!toRow) throw new CubeError(`No row ${toRowRef}.`);
  let num = nextBoxNum(toRow, root);
  let width = toRow.width;
  if (widthFor(num) > width) {
    repadRow(root, toRow, widthFor(num));
    width = widthFor(num);
  }
  const fresh = loadCube(root);
  const src = getBox(fresh, box.id)!;
  const dstRow = getRow(fresh, toRow.num)!;
  const newId = boxId(dstRow.num, num, width);
  const newDir = join(dstRow.dir, boxDirName(num, src.name, width));
  renameSync(src.dir, newDir);
  moveState(root, src.id, newId);
  updateZ0(root, newId, (h, body) => ({ header: { ...h, id: newId }, body }));
  rewriteReferences(root, new Map([[idKey(src.id)!, newId]]));
  addAliases(root, [{ alias: src.id, target: newId }]);
  retire(root, src.id, `moved to ${newId}`);
  return { from: src.id, to: newId };
}

export function deleteBox(root: string, id: string, reason: string): string {
  const cube = loadCube(root);
  const box = getBox(cube, id);
  if (!box) throw new CubeError(`No box ${id}.`);
  if (box.isRoot) throw new CubeError("A row's root box can't be deleted on its own.");
  remove(box.dir);
  removeBoxState(root, box.id);
  retire(root, box.id, reason || "deleted");
  return box.id;
}

/** Re-pads every box number in a row (e.g. X999 → X0999) when it passes 999. */
export function repadRow(root: string, row: Row, width: number): void {
  const mapping = new Map<string, string>();
  for (const b of row.allBoxes) {
    const newId = boxId(row.num, b.num, width);
    const newDir = join(row.dir, boxDirName(b.num, b.name, width));
    if (newDir !== b.dir) renameSync(b.dir, newDir);
    moveState(root, b.id, newId);
    mapping.set(idKey(b.id)!, newId);
  }
  for (const [, newId] of mapping) {
    const c = loadCube(root);
    const b = getBox(c, newId);
    if (b?.header) updateZ0(root, newId, (h, body) => ({ header: { ...h, id: newId }, body }));
  }
  rewriteReferences(root, mapping);
}

function moveState(root: string, from: string, to: string): void {
  if (from === to) return;
  const st = loadBoxState(root, from);
  if (!st) return;
  removeBoxState(root, from);
  saveBoxState(root, { ...st, id: to });
}

/** Rewrites header links and inline references everywhere, using box keys → new ids. */
export function rewriteReferences(root: string, mapping: Map<string, string>): void {
  const cube = loadCube(root);
  const rewrite = (ref: string): string | undefined => {
    const c = parseId(ref);
    if (!c || c.box === undefined) return undefined;
    const target = mapping.get(idKey(ref)!);
    if (!target) return undefined;
    return c.drawer !== undefined ? `${target}.Z${c.drawer}` : target;
  };
  for (const box of allBoxes(cube)) {
    for (const d of box.drawers) {
      const text = readTextOr(d.path, "");
      let next: string;
      if (d.z === 0) {
        const doc = parseDoc(text);
        if (!doc.header) {
          next = rewriteInlineRefs(text, rewrite);
        } else {
          const links = doc.header.links.map((l) => ({ ...l, to: rewrite(l.to) ?? l.to }));
          next = renderDoc({ ...doc.header, links }, rewriteInlineRefs(doc.body, rewrite));
        }
      } else {
        next = rewriteInlineRefs(text, rewrite);
      }
      if (next !== text) writeText(d.path, next);
    }
  }
}

/** Keeps every link's `name` equal to its target's current name. */
export function syncLinkNames(root: string): number {
  const cube = loadCube(root);
  let changed = 0;
  for (const box of allBoxes(cube)) {
    if (!box.header) continue;
    let dirty = false;
    const links = box.header.links.map((l) => {
      const t = getBox(cube, l.to) ?? (parseId(l.to)?.box === undefined ? getRow(cube, l.to)?.root : undefined);
      const name = t ? targetName(cube, t) : undefined;
      if (name && l.name !== name) {
        dirty = true;
        return { ...l, name };
      }
      return l;
    });
    if (dirty) {
      const text = readTextOr(drawerPath(box, 0), "");
      const doc = parseDoc(text);
      writeText(drawerPath(box, 0), renderDoc({ ...doc.header!, links }, doc.body));
      changed++;
    }
  }
  return changed;
}

// ---------- state ----------

/** Records checksums of every drawer's own text. */
export function touchState(root: string, id: string, dir: string, now = new Date()): BoxState {
  const st = loadBoxState(root, id) ?? newBoxState(id, now);
  st.updated = now.toISOString();
  st.drawers = {};
  for (const d of DRAWERS) {
    const path = join(dir, d.file);
    if (!exists(path)) continue;
    let own = splitGenerated(readTextOr(path, "")).own;
    if (d.z === 0) own = splitGenerated(parseDoc(readTextOr(path, "")).body).own;
    st.drawers[`Z${d.z}`] = { sha: sha(own), chars: own.length };
  }
  saveBoxState(root, st);
  return st;
}

export function hasState(root: string, id: string): boolean {
  return exists(boxStatePath(root, id));
}

// ---------- helpers ----------

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function ensureNl(s: string): string {
  if (s === "") return "";
  return s.endsWith("\n") ? s : `${s}\n`;
}

export { rowId };

// ---------- bulk updates (used by the build, where hundreds of boxes change at once) ----------

export interface HeaderUpdate {
  status?: Status;
  name?: string;
  summary?: string;
  readWhen?: string;
  scope?: string;
  /** Rules only: file globs; an empty list makes the rule load every session again. */
  paths?: string[];
  addLinks?: Link[];
  writtenBy?: Writer;
}

/** Applies many header updates, loading the cube once. Renames folders when names change. */
export function bulkUpdateHeaders(root: string, updates: Map<string, HeaderUpdate>): void {
  const cube = loadCube(root);
  for (const [id, u] of updates) {
    const box = getBox(cube, id);
    if (!box || !box.header) continue;
    const path = drawerPath(box, 0);
    const doc = parseDoc(readTextOr(path, ""));
    if (!doc.header) continue;
    const h = { ...doc.header };
    if (u.summary) h.summary = oneLine(u.summary);
    if (u.readWhen) h.read_when = oneLine(u.readWhen);
    if (u.scope) h.scope = oneLine(u.scope);
    if (u.paths) h.paths = u.paths.length ? u.paths : undefined;
    if (u.writtenBy) h.written_by = u.writtenBy;
    if (u.status) h.status = u.status;
    if (u.addLinks?.length) {
      const links = [...h.links];
      for (const l of u.addLinks) {
        if (idKey(l.to) === idKey(box.id)) continue;
        if (links.some((x) => idKey(x.to) === idKey(l.to) && x.rel === l.rel)) continue;
        const target = getBox(cube, l.to) ?? (parseId(l.to)?.box === undefined ? getRow(cube, l.to)?.root : undefined);
        if (!target) continue;
        links.push({ to: canonicalId(cube, l.to) ?? l.to, name: target.isRoot ? getRow(cube, target.rowNum)!.name : target.name, rel: l.rel, note: l.note });
      }
      h.links = links;
    }
    let dir = box.dir;
    if (u.name && !box.isRoot) {
      const name = isValidName(u.name) ? u.name : slugify(u.name);
      if (name !== box.name) {
        const row = getRow(cube, box.rowNum)!;
        dir = join(row.dir, boxDirName(box.num, name, row.width));
        if (!exists(dir)) {
          renameSync(box.dir, dir);
          h.name = name;
        } else dir = box.dir;
      }
    }
    writeText(join(dir, "Z0-overview.md"), renderDoc(h, doc.body));
    const st = loadBoxState(root, box.id);
    touchState(root, box.id, dir);
    if (st?.sources) {
      const again = loadBoxState(root, box.id)!;
      again.sources = st.sources;
      saveBoxState(root, again);
    }
  }
}
