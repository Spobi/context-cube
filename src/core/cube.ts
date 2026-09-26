import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { cubePaths, type CubePaths } from "./paths";
import { isDir, readTextOr } from "./fsutil";
import { BOX_DIR_RE, ROW_DIR_RE, boxId, rowId, idKey, parseId, widthFor } from "./format/ids";
import { DRAWERS, DRAWER_FILE_RE, type RowType, ROW_TYPES } from "./format/drawers";
import { parseDoc, type Header, type ParsedDoc } from "./format/header";
import { estimateTokens } from "./tokens";

export { ROW_DIR_RE } from "./format/ids";

export interface DrawerInfo {
  z: number;
  file: string;
  path: string;
  chars: number;
}

export interface Box {
  rowNum: number;
  num: number;
  id: string;
  /** Name from the folder. The header's name should match. */
  name: string;
  dir: string;
  /** Folder relative to the cube folder, e.g. "Y05-webrtc/X003-ice-restart". */
  relDir: string;
  isRoot: boolean;
  drawers: DrawerInfo[];
  /** Drawer-like files that don't follow the naming rules. */
  strayFiles: string[];
  doc?: ParsedDoc;
  header?: Header;
  /** Folders inside the box (e.g. fragments/). */
  subdirs: string[];
}

export interface Row {
  num: number;
  id: string;
  name: string;
  dir: string;
  relDir: string;
  type: RowType;
  width: number;
  root?: Box;
  /** Boxes other than the root, by number. */
  boxes: Box[];
  /** Every box folder, including duplicates. */
  allBoxes: Box[];
  strayDirs: string[];
}

export interface Cube {
  root: string;
  paths: CubePaths;
  rows: Row[];
  /** Every row folder, including duplicate numbers. */
  allRows: Row[];
  byKey: Map<string, Box>;
  strayDirs: string[];
}

function drawersOf(dir: string): { drawers: DrawerInfo[]; stray: string[]; subdirs: string[] } {
  const drawers: DrawerInfo[] = [];
  const stray: string[] = [];
  const subdirs: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return { drawers, stray, subdirs };
  }
  for (const name of names.sort()) {
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      subdirs.push(name);
      continue;
    }
    const spec = DRAWERS.find((d) => d.file === name);
    if (spec) drawers.push({ z: spec.z, file: name, path, chars: st.size });
    else if (DRAWER_FILE_RE.test(name) || name.endsWith(".md")) stray.push(name);
  }
  return { drawers, stray, subdirs };
}

export function loadCube(root: string): Cube {
  const paths = cubePaths(root);
  const cube: Cube = { root, paths, rows: [], allRows: [], byKey: new Map(), strayDirs: [] };
  if (!isDir(paths.cube)) return cube;
  const seenRows = new Set<number>();
  for (const name of readdirSync(paths.cube).sort()) {
    const dir = join(paths.cube, name);
    if (!isDir(dir) || name.startsWith(".")) continue;
    const m = ROW_DIR_RE.exec(name);
    if (!m) {
      cube.strayDirs.push(name);
      continue;
    }
    const row = loadRow(dir, Number(m[1]), m[2], paths.cube);
    cube.allRows.push(row);
    if (seenRows.has(row.num)) continue;
    seenRows.add(row.num);
    cube.rows.push(row);
    for (const b of row.allBoxes) {
      const key = idKey(b.id)!;
      if (!cube.byKey.has(key)) cube.byKey.set(key, b);
    }
  }
  cube.rows.sort((a, b) => a.num - b.num);
  return cube;
}

function loadRow(dir: string, num: number, name: string, cubeDir: string): Row {
  const boxDirs: { name: string; num: number; boxName: string }[] = [];
  const strayDirs: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    if (!isDir(abs)) continue;
    const m = BOX_DIR_RE.exec(entry);
    if (!m) {
      strayDirs.push(entry);
      continue;
    }
    boxDirs.push({ name: entry, num: Number(m[1]), boxName: m[2] });
  }
  const maxNum = boxDirs.reduce((mx, b) => Math.max(mx, b.num), 0);
  const digits = boxDirs.reduce((mx, b) => Math.max(mx, b.name.indexOf("-") - 1), 3);
  const width = Math.max(widthFor(maxNum), digits);
  const row: Row = {
    num,
    id: rowId(num),
    name,
    dir,
    relDir: relative(cubeDir, dir),
    type: "custom",
    width,
    boxes: [],
    allBoxes: [],
    strayDirs,
  };
  const seen = new Set<number>();
  for (const bd of boxDirs) {
    const bdir = join(dir, bd.name);
    const { drawers, stray, subdirs } = drawersOf(bdir);
    const box: Box = {
      rowNum: num,
      num: bd.num,
      id: boxId(num, bd.num, width),
      name: bd.boxName,
      dir: bdir,
      relDir: relative(cubeDir, bdir),
      isRoot: bd.num === 0,
      drawers,
      strayFiles: stray,
      subdirs,
    };
    const z0 = drawers.find((d) => d.z === 0);
    if (z0) {
      box.doc = parseDoc(readTextOr(z0.path, ""));
      box.header = box.doc.header;
    }
    row.allBoxes.push(box);
    if (seen.has(bd.num)) continue;
    seen.add(bd.num);
    if (box.isRoot) row.root = box;
    else row.boxes.push(box);
  }
  row.boxes.sort((a, b) => a.num - b.num);
  const t = row.root?.header?.row_type;
  if (t && (ROW_TYPES as readonly string[]).includes(t)) row.type = t;
  else if (num === 0) row.type = "rules";
  return row;
}

export function cubeHasRows(root: string): boolean {
  return loadCube(root).rows.length > 0;
}

export function getRow(cube: Cube, ref: string | number): Row | undefined {
  if (typeof ref === "number") return cube.rows.find((r) => r.num === ref);
  const c = parseId(ref);
  if (c) return cube.rows.find((r) => r.num === c.row);
  return cube.rows.find((r) => r.name === ref);
}

export function getBox(cube: Cube, id: string): Box | undefined {
  const key = idKey(id);
  return key ? cube.byKey.get(key) : undefined;
}

/** Canonical id for any id (padding normalized to the row's width). */
export function canonicalId(cube: Cube, id: string): string | undefined {
  const c = parseId(id);
  if (!c) return undefined;
  const row = getRow(cube, c.row);
  if (!row) return undefined;
  if (c.box === undefined) return row.id;
  const b = getBox(cube, id);
  if (!b) return undefined;
  return c.drawer === undefined ? b.id : `${b.id}.Z${c.drawer}`;
}

export function drawerPath(box: Box, z: number): string {
  const spec = DRAWERS.find((d) => d.z === z);
  if (!spec) throw new Error(`No drawer Z${z}`);
  return join(box.dir, spec.file);
}

export function readDrawer(box: Box, z: number): string | undefined {
  const d = box.drawers.find((x) => x.z === z);
  return d ? readTextOr(d.path, "") : undefined;
}

export function boxTokens(box: Box, charsPerToken = 4): number {
  return box.drawers.reduce((s, d) => s + estimateTokens(d.chars, charsPerToken), 0);
}

/** All box ids in the cube, including roots. */
export function allBoxes(cube: Cube): Box[] {
  return cube.rows.flatMap((r) => (r.root ? [r.root, ...r.boxes] : r.boxes));
}

/**
 * A pending invariant is a candidate: agents can see it, labeled as not yet
 * approved, but nothing enforces it until a person approves it (plan 9.1).
 */
export function isCandidate(box: Box | undefined): boolean {
  return box?.header?.status === "pending";
}

export function rowOfBox(cube: Cube, box: Box): Row {
  return cube.rows.find((r) => r.num === box.rowNum)!;
}
