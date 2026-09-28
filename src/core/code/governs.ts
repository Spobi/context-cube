import { allBoxes, getBox, getRow, isCandidate, type Box, type Cube } from "../cube";
import { loadBoxState } from "../state/state";
import { isPlainWord } from "./search";

/**
 * Which approved invariants govern each code file (no AI). An invariant
 * governs the files its own text clearly points to, the clearest few of them.
 * Only an invariant whose text names no code borrows files, from the boxes that
 * link to it: otherwise an invariant linked from a dozen feature boxes would
 * load on every file they touch, and "a rule that must never be broken" would
 * show up everywhere and mean nothing. Path rules, Codex's rule notices, and the
 * stats' possible misses all use this, so they agree on what an agent should
 * read before editing a file.
 */

/** A code link at least this strong counts: a named file, a specific code name defined there, or two lesser names. */
export const STRONG = 2;

/**
 * How strongly a code link's reasons tie a box to a file: 3 when its text
 * names the file, 2 per specific code name (`clockHandshake`, `peer_caps`)
 * defined there or found only there, 1 per specific name only used there
 * ("`AppInfo` (used at line 53)") and per plain word (`decline`), which may
 * just be prose.
 */
export function linkStrength(why: string): number {
  let n = /named in the text|names the file/.test(why) ? 3 : 0;
  for (const m of why.matchAll(/`([^`]+)`( \(used\b)?/g)) n += isPlainWord(m[1]) || m[2] ? 1 : 2;
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
  /** How clearly the invariant (or, when it borrows, the boxes linking to it) points to the file. */
  score: number;
  /** The invariant's own reasons ("`timerSync` (line 43), …"), if its text names the file's code. */
  own?: string;
  /** The boxes it borrowed the file from, when its own text names no code. */
  via: string[];
}

/** At most this many files per invariant: the ones it points to most clearly. */
export const MAX_GOVERNED = 12;

/** For each code file, the invariants that govern it, most clearly linked first. */
export function governingByFile(cube: Cube): Map<string, Governing[]> {
  type Governed = { file: string; g: Governing };
  const own = new Map<string, Governed[]>();
  const lent = new Map<string, Map<string, Governed>>();
  for (const b of allBoxes(cube)) {
    if (b.isRoot || !b.header || isCandidate(b) || b.header.status === "superseded") continue;
    const type = getRow(cube, b.rowNum)?.type;
    if (type === "history" || type === "rules") continue;
    for (const f of loadBoxState(cube.root, b.id)?.code?.files ?? []) {
      const s = linkStrength(f.why);
      if (s < STRONG) continue;
      if (type === "invariants") {
        own.set(b.id, [...(own.get(b.id) ?? []), { file: f.path, g: { inv: b, score: s, own: f.why, via: [] } }]);
        continue;
      }
      for (const i of invariantsFor(cube, b)) {
        const m = lent.get(i.id) ?? new Map<string, Governed>();
        lent.set(i.id, m);
        const e = m.get(f.path) ?? { file: f.path, g: { inv: i, score: 0, via: [] } };
        e.g.score += s;
        e.g.via.push(b.id);
        m.set(f.path, e);
      }
    }
  }
  const out = new Map<string, Governing[]>();
  const keep = (list: Governed[]) => {
    for (const { file, g } of list.sort((a, b) => b.g.score - a.g.score || a.file.localeCompare(b.file)).slice(0, MAX_GOVERNED)) out.set(file, [...(out.get(file) ?? []), g]);
  };
  for (const list of own.values()) keep(list);
  for (const [id, m] of lent) if (!own.has(id)) keep([...m.values()]);
  for (const list of out.values()) list.sort((a, b) => b.score - a.score || a.inv.id.localeCompare(b.inv.id));
  return out;
}
