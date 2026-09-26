import { allBoxes, getBox, getRow, loadCube, type Box, type Cube } from "../cube";
import { loadBoxState } from "../state/state";
import { buildCodeIndex, filesWithName, fingerprint, type CodeIndex } from "./search";
import { bulkUpdateHeaders } from "../ops";
import { git, gitRoot } from "../git";

/**
 * Staleness (plan 8.4). A box is `stale` when a file in its Z2 changed since
 * the box was last updated (fingerprints; no tokens). A box in an invariants,
 * feature, system, catalog, custom, or rules row is `needs-review` when a code
 * name it mentions no longer exists in the code. History boxes are exempt:
 * they describe the past.
 */

export interface BoxStatus {
  id: string;
  name: string;
  status: "stale" | "needs-review";
  reasons: string[];
  files: string[];
}

export function computeStatus(root: string, opts: { onlyFiles?: Set<string>; cube?: Cube; index?: CodeIndex } = {}): BoxStatus[] {
  const cube = opts.cube ?? loadCube(root);
  let idx = opts.index;
  const out: BoxStatus[] = [];
  for (const box of allBoxes(cube)) {
    if (box.isRoot) continue;
    const row = getRow(cube, box.rowNum)!;
    if (row.type === "history") continue;
    const st = loadBoxState(root, box.id);
    const fps = st?.fingerprints ?? {};
    const files = Object.keys(fps);
    if (opts.onlyFiles && !files.some((f) => opts.onlyFiles!.has(f))) continue;
    const reasons: string[] = [];
    const changed: string[] = [];
    for (const f of files) {
      const now = fingerprint(root, f);
      if (now === undefined) {
        reasons.push(`${f} was deleted`);
        changed.push(f);
      } else if (fps[f] && now !== fps[f]) {
        reasons.push(`${f} changed`);
        changed.push(f);
      }
    }
    let missing: string[] = [];
    if (st?.names?.length) {
      idx ??= buildCodeIndex(root);
      missing = st.names.filter((n) => filesWithName(idx!, n, 1).length === 0);
      for (const n of missing) reasons.push(`\`${n}\` is no longer in the code`);
    }
    if (!reasons.length) continue;
    out.push({ id: box.id, name: box.name, status: missing.length ? "needs-review" : "stale", reasons, files: changed });
  }
  return out;
}

/** Writes stale / needs-review into the headers of the boxes found. Returns how many changed. */
export function applyStatus(root: string, results: BoxStatus[]): number {
  const cube = loadCube(root);
  let n = 0;
  const updates = new Map<string, { status: BoxStatus["status"] }>();
  for (const r of results) {
    const box = getBox(cube, r.id);
    if (!box?.header) continue;
    // needs-review outranks stale; pending and open are left alone.
    const cur = box.header.status;
    if (cur === "pending" || cur === "open" || cur === r.status || (cur === "needs-review" && r.status === "stale")) continue;
    updates.set(box.id, { status: r.status });
    n++;
  }
  if (updates.size) setStatuses(root, updates);
  return n;
}

export function setStatuses(root: string, updates: Map<string, { status: "ok" | "stale" | "needs-review" | "pending" | "open" }>): void {
  bulkUpdateHeaders(root, new Map([...updates].map(([id, u]) => [id, { status: u.status }])));
}

/** Files touched by recent work: uncommitted changes plus the last few commits. */
export function recentFiles(root: string, commits = 10): Set<string> {
  const out = new Set<string>();
  if (!gitRoot(root)) return out;
  const status = git(["status", "--porcelain"], root);
  for (const line of status.stdout.split("\n")) {
    const p = line.slice(3).trim();
    if (p) out.add(p.includes(" -> ") ? p.split(" -> ")[1] : p);
  }
  const log = git(["log", `-n${commits}`, "--name-only", "--format="], root);
  for (const p of log.stdout.split("\n")) if (p.trim()) out.add(p.trim());
  return out;
}

export function boxesWithFile(root: string, cube: Cube, file: string): Box[] {
  return allBoxes(cube).filter((b) => Object.keys(loadBoxState(root, b.id)?.fingerprints ?? {}).includes(file));
}
