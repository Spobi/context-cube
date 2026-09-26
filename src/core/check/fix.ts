import { renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { readTextOr, writeText } from "../fsutil";
import { git, gitRoot } from "../git";
import { allBoxes, loadCube, type Box, type Row } from "../cube";
import { boxDirName, boxId, rowDirName, rowId } from "../format/ids";
import { parseDoc, renderDoc } from "../format/header";
import { rewriteInlineRefs } from "../format/links";
import { nextBoxNum, nextRowNum, touchState } from "../ops";
import { addAliases, loadBoxState, saveBoxState } from "../state/state";
import { cubePaths } from "../paths";

/** When a folder was first added to git (seconds), or its mtime without git. */
function createdAt(root: string, dir: string): number {
  if (gitRoot(root)) {
    const r = git(["log", "--diff-filter=A", "--follow", "--format=%ct", "--", join(dir, "Z0-overview.md")], root);
    const times = r.stdout.trim().split("\n").filter(Boolean).map(Number);
    if (times.length) return Math.min(...times);
    // Not committed yet: newest of all.
    return Number.MAX_SAFE_INTEGER - 1;
  }
  try {
    return statSync(dir).birthtimeMs / 1000;
  } catch {
    return 0;
  }
}

/**
 * Duplicate numbers after a merge (plan 11): two branches both created Y05.X016.
 * Renumbers the more recently created box, rewrites links that meant it (links
 * carry the target's name, which tells the two apart), and records an alias.
 */
export function fixDuplicates(root: string): string[] {
  const out: string[] = [];
  let cube = loadCube(root);

  // Rows first.
  const byRow = new Map<number, Row[]>();
  for (const r of cube.allRows) byRow.set(r.num, [...(byRow.get(r.num) ?? []), r]);
  for (const [, rows] of byRow) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((a, b) => createdAt(root, a.dir) - createdAt(root, b.dir));
    for (const row of sorted.slice(1)) {
      cube = loadCube(root);
      const num = nextRowNum(cube, root);
      const newDir = join(cubePaths(root).cube, rowDirName(num, row.name));
      renameSync(row.dir, newDir);
      const moved = loadCube(root).allRows.find((r) => r.dir === newDir)!;
      const mapping = new Map<string, string>();
      for (const b of moved.allBoxes) {
        const newId = boxId(num, b.num, moved.width);
        mapping.set(`${b.name}@${b.id}`, newId);
        rewriteOwnHeader(b, newId);
        moveStateFile(root, b.id, newId, b.name);
      }
      rewriteByName(root, mapping);
      addAliases(root, [{ alias: `${row.id} ${row.name}`, target: rowId(num) }]);
      out.push(`Row ${row.id} ${row.name} was a duplicate number; it is now ${rowId(num)}.`);
    }
  }

  // Then boxes.
  cube = loadCube(root);
  for (const row of cube.rows) {
    const byNum = new Map<number, Box[]>();
    for (const b of row.allBoxes) byNum.set(b.num, [...(byNum.get(b.num) ?? []), b]);
    for (const [, boxes] of byNum) {
      if (boxes.length < 2) continue;
      const sorted = [...boxes].sort((a, b) => createdAt(root, a.dir) - createdAt(root, b.dir));
      for (const b of sorted.slice(1)) {
        const fresh = loadCube(root).rows.find((r) => r.num === row.num)!;
        const num = nextBoxNum(fresh, root);
        const newId = boxId(row.num, num, fresh.width);
        const newDir = join(fresh.dir, boxDirName(num, b.name, fresh.width));
        renameSync(b.dir, newDir);
        const movedBox = { ...b, dir: newDir, drawers: b.drawers.map((d) => ({ ...d, path: join(newDir, d.file) })) };
        rewriteOwnHeader(movedBox, newId);
        moveStateFile(root, b.id, newId, b.name);
        rewriteByName(root, new Map([[`${b.name}@${b.id}`, newId]]));
        addAliases(root, [{ alias: `${b.id} ${b.name}`, target: newId }]);
        touchState(root, newId, newDir);
        out.push(`${b.id} ${b.name} was a duplicate number; it is now ${newId}.`);
      }
    }
  }
  return out;
}

function rewriteOwnHeader(b: Box, newId: string): void {
  const z0 = b.drawers.find((d) => d.z === 0);
  if (!z0) return;
  const text = readTextOr(z0.path, "");
  const doc = parseDoc(text);
  if (doc.header) writeText(z0.path, renderDoc({ ...doc.header, id: newId }, doc.body));
}

function moveStateFile(root: string, oldId: string, newId: string, name: string): void {
  // Both duplicates share one state file; keep it for the box that stays and give
  // the renumbered box a copy under its new id.
  const st = loadBoxState(root, oldId);
  if (st) saveBoxState(root, { ...st, id: newId });
  void name;
}

/**
 * Rewrites links whose target id is ambiguous. `mapping` keys are "name@oldId";
 * a link is rewritten when its `name` matches. Inline refs can't be told apart,
 * so they're left alone (check will report any that now point at the wrong box).
 */
function rewriteByName(root: string, mapping: Map<string, string>): void {
  const cube = loadCube(root);
  for (const box of allBoxes(cube)) {
    const z0 = box.drawers.find((d) => d.z === 0);
    if (!z0 || !box.header) continue;
    let dirty = false;
    const links = box.header.links.map((l) => {
      for (const [key, newId] of mapping) {
        const [name, oldId] = key.split("@");
        if (l.name === name && sameKey(l.to, oldId)) {
          dirty = true;
          return { ...l, to: newId };
        }
      }
      return l;
    });
    if (dirty) {
      const doc = parseDoc(readTextOr(z0.path, ""));
      writeText(z0.path, renderDoc({ ...doc.header!, links }, rewriteInlineRefs(doc.body, () => undefined)));
    }
  }
}

function sameKey(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/X0+(\d)/, "X$1");
  return n(a) === n(b);
}
