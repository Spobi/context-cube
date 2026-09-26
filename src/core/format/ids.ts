/**
 * Coordinates (plan 3.1). Rows are Y + 2 digits, boxes X + 3 digits (more if a
 * row passes 999), drawers Z + 1 digit. `Y05.X003` is a box, `Y05.X003.Z1` a
 * drawer. Numbers compare numerically, so X001 and X0001 are the same box.
 */

export interface Coord {
  row: number;
  box?: number;
  drawer?: number;
}

const ID_RE = /^Y(\d{2})(?:\.X(\d{3,})(?:\.Z(\d))?)?$/;

export function parseId(id: string): Coord | undefined {
  const m = ID_RE.exec(id.trim());
  if (!m) return undefined;
  const c: Coord = { row: Number(m[1]) };
  if (m[2] !== undefined) c.box = Number(m[2]);
  if (m[3] !== undefined) c.drawer = Number(m[3]);
  return c;
}

export function isId(s: string): boolean {
  return parseId(s) !== undefined;
}

export function rowId(row: number): string {
  if (row < 0 || row > 99) throw new Error(`Row number out of range: ${row}`);
  return `Y${String(row).padStart(2, "0")}`;
}

export function boxPart(box: number, width = 3): string {
  return `X${String(box).padStart(Math.max(width, String(box).length), "0")}`;
}

export function boxId(row: number, box: number, width = 3): string {
  return `${rowId(row)}.${boxPart(box, width)}`;
}

export function drawerId(row: number, box: number, drawer: number, width = 3): string {
  return `${boxId(row, box, width)}.Z${drawer}`;
}

/** Canonical form of any id, with the row's box width. */
export function formatCoord(c: Coord, width = 3): string {
  if (c.box === undefined) return rowId(c.row);
  if (c.drawer === undefined) return boxId(c.row, c.box, width);
  return drawerId(c.row, c.box, c.drawer, width);
}

/** The box a drawer or box id belongs to, as "Y05.X003". */
export function boxOf(id: string, width = 3): string | undefined {
  const c = parseId(id);
  if (!c || c.box === undefined) return undefined;
  return boxId(c.row, c.box, width);
}

export function sameBox(a: string, b: string): boolean {
  const x = parseId(a);
  const y = parseId(b);
  return !!x && !!y && x.row === y.row && x.box === y.box;
}

/** Key for maps: numeric, so padding differences don't matter. */
export function coordKey(c: Coord): string {
  return c.box === undefined ? `${c.row}` : `${c.row}.${c.box}`;
}

export function idKey(id: string): string | undefined {
  const c = parseId(id);
  return c ? coordKey(c) : undefined;
}

/** Row folder: Y05-webrtc. Box folder: X003-ice-restart. */
export const ROW_DIR_RE = /^Y(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
export const BOX_DIR_RE = /^X(\d{3,})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export function rowDirName(row: number, name: string): string {
  return `${rowId(row)}-${name}`;
}

export function boxDirName(box: number, name: string, width = 3): string {
  return `${boxPart(box, width)}-${name}`;
}

/** Box number width needed for a row whose highest box number is `max`. */
export function widthFor(max: number): number {
  return Math.max(3, String(max).length);
}
