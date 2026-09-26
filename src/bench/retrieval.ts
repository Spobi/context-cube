import { join } from "node:path";
import { getBox, getRow, loadCube } from "../core/cube";
import { readTextOr } from "../core/fsutil";
import { splitGenerated } from "../core/format/generated";
import { loadBoxState } from "../core/state/state";
import { categorize } from "../core/logs/report";
import { CUBE_DIR } from "../core/paths";
import type { ReadRecord } from "../core/logs/extract";
import type { EditRecord } from "../core/logs/store";

/**
 * Retrieval measures for a bench run (Phase 9), so the report can say why a copy
 * did better or worse, not only whether it did: was each invariant the task must
 * respect read before the first code edit, how many reads it took to get there,
 * and how much memory was read before editing. Both copies are measured the same
 * way: an invariant counts as found once at least half of its text was shown to
 * the agent (its Z1 in the cube copy; its lines of the original file in the files
 * copy).
 */

export interface Span {
  file: string;
  start: number;
  end: number;
}

export interface Required {
  id: string;
  /** Where the invariant's text is in the cube copy (its Z1). */
  cube: Span[];
  /** Where it was in the original files (files copy). */
  files: Span[];
}

export interface Retrieval {
  required: number;
  /** Required invariants shown to the agent before its first code edit. */
  found: number;
  /** Reads (any file) before the first required invariant was found; undefined if none was. */
  readsToFind?: number;
  /** Reads (any file) before the first code edit. */
  readsBeforeEdit: number;
  /** Estimated tokens of memory files or cube files read before the first code edit. */
  memoryBeforeEdit: number;
}

/** The task's invariants that are box ids, with where their text lives in each copy. */
export function requiredFor(cubeRoot: string, ids: string[]): Required[] {
  const cube = loadCube(cubeRoot);
  const out: Required[] = [];
  for (const id of ids) {
    const box = getBox(cube, id);
    if (!box || getRow(cube, box.rowNum)?.type !== "invariants") continue;
    const z1 = splitGenerated(readTextOr(join(box.dir, "Z1-invariants.md"), "")).own;
    const lines = z1.split("\n").length - (z1.endsWith("\n") ? 1 : 0);
    const sources = (loadBoxState(cubeRoot, box.id)?.sources ?? []).filter((s) => s.drawer === 1);
    out.push({
      id: box.id,
      cube: lines > 0 ? [{ file: `${CUBE_DIR}/${box.relDir}/Z1-invariants.md`, start: 1, end: lines }] : [],
      files: sources.map((s) => ({ file: s.file, start: s.start, end: s.end })),
    });
  }
  return out;
}

/** The fraction of the lines in `spans` that `reads` showed the agent. */
function coverage(spans: Span[], reads: ReadRecord[]): number {
  let total = 0;
  let seen = 0;
  for (const s of spans) {
    const shown = new Set<number>();
    for (const r of reads) {
      if (r.file !== s.file) continue;
      // Instructions (CLAUDE.md and its imports) load whole files.
      const ranges = r.tool === "Instructions" ? [[s.start, s.end]] : (r.ranges ?? []);
      for (const [a, b] of ranges) for (let n = Math.max(a, s.start); n <= Math.min(b, s.end); n++) shown.add(n);
    }
    total += s.end - s.start + 1;
    seen += shown.size;
  }
  return total ? seen / total : 0;
}

export function measureRetrieval(copy: "files" | "cube", required: Required[], reads: ReadRecord[], edits: EditRecord[], memoryFiles: string[]): Retrieval {
  const sorted = [...reads].sort((a, b) => a.t.localeCompare(b.t));
  const firstEdit = edits
    .filter((e) => !e.file.startsWith(`${CUBE_DIR}/`))
    .map((e) => e.t)
    .sort()[0];
  const beforeEdit = sorted.filter((r) => !firstEdit || r.t <= firstEdit);
  const counted = (r: ReadRecord) => r.tool !== "Instructions";
  let found = 0;
  let firstFound: number | undefined;
  for (const req of required) {
    const spans = copy === "cube" ? req.cube : req.files;
    if (!spans.length) continue;
    // Walk the reads in order until half the invariant has been shown.
    for (let i = 0; i < beforeEdit.length; i++) {
      if (coverage(spans, beforeEdit.slice(0, i + 1)) >= 0.5) {
        found++;
        const n = beforeEdit.slice(0, i + 1).filter(counted).length;
        firstFound = firstFound === undefined ? n : Math.min(firstFound, n);
        break;
      }
    }
  }
  const memory = new Set(memoryFiles);
  return {
    required: required.length,
    found,
    readsToFind: firstFound,
    readsBeforeEdit: beforeEdit.filter(counted).length,
    memoryBeforeEdit: beforeEdit.filter((r) => categorize(r.file, memory) !== "other" && categorize(r.file, memory) !== "outside").reduce((n, r) => n + r.tokens, 0),
  };
}
