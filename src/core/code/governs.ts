import { allBoxes, getBox, getRow, isCandidate, type Box, type Cube } from "../cube";
import { loadBoxState } from "../state/state";
import { isPlainWord } from "./search";

/**
 * Which approved invariants govern each code file, and how sure the cube is
 * (no AI). An invariant governs a file when its own text names the file or the
 * file's code, or when a box that clearly covers the file links to it. Path
 * rules, `cube related`, and the stats' possible misses all use this, so they
 * agree on what an agent should read before editing a file.
 */

/** A code link at least this strong counts: a named file, one specific code name, or two plain words. */
export const STRONG = 2;

/**
 * How strongly a code link's reasons tie a box to a file: 3 when its text
 * names the file, 2 per specific code name (`clockHandshake`, `peer_caps`),
 * 1 per plain word (`decline`), which may just be prose.
 */
export function linkStrength(why: string): number {
  let n = /named in the text|names the file/.test(why) ? 3 : 0;
  for (const m of why.matchAll(/`([^`]+)`/g)) n += isPlainWord(m[1]) ? 1 : 2;
  n += Number(/and (\d+) more/.exec(why)?.[1] ?? 0);
  return n;
}

/** The approved invariants a box is governed by: itself, if it is one, or those its header links to. */
export function invariantsFor(cube: Cube, box: Box): Box[] {
  const row = getRow(cube, box.rowNum)!;
  if (row.type === "invariants") return isCandidate(box) ? [] : [box];
  return (box.header?.links ?? []).map((l) => getBox(cube, l.to)).filter((b): b is Box => !!b && getRow(cube, b.rowNum)?.type === "invariants" && !isCandidate(b));
}

export interface Governing {
  inv: Box;
  /** Own link strength, plus STRONG for each box that clearly covers the file and links to it. */
  score: number;
  /** The invariant's own reasons ("`timerSync` (line 43), …"), if its text names the file's code. */
  own?: string;
  /** Boxes that clearly cover the file and link to the invariant. */
  via: string[];
}

/** For each code file, the invariants linked to it, strongest first (weak ones included; filter by STRONG). */
export function governingByFile(cube: Cube): Map<string, Governing[]> {
  const byFile = new Map<string, Map<string, Governing>>();
  const entry = (file: string, inv: Box): Governing => {
    const m = byFile.get(file) ?? new Map<string, Governing>();
    byFile.set(file, m);
    const g = m.get(inv.id) ?? { inv, score: 0, via: [] };
    m.set(inv.id, g);
    return g;
  };
  for (const b of allBoxes(cube)) {
    if (b.isRoot || !b.header || isCandidate(b) || b.header.status === "superseded") continue;
    const type = getRow(cube, b.rowNum)?.type;
    if (type === "history" || type === "rules") continue;
    for (const f of loadBoxState(cube.root, b.id)?.code?.files ?? []) {
      const s = linkStrength(f.why);
      if (type === "invariants") {
        const g = entry(f.path, b);
        g.score += s;
        g.own = f.why;
      } else if (s >= STRONG) {
        for (const i of invariantsFor(cube, b)) {
          if (i.id === b.id) continue;
          const g = entry(f.path, i);
          g.score += STRONG;
          g.via.push(b.id);
        }
      }
    }
  }
  const out = new Map<string, Governing[]>();
  for (const [file, m] of byFile) out.set(file, [...m.values()].sort((a, b) => b.score - a.score || a.inv.id.localeCompare(b.inv.id)));
  return out;
}
