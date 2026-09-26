import { findProjectRoot, TOOL_COMMAND } from "../core/paths";
import { loadCube, getBox } from "../core/cube";
import { CubeError } from "../core/ops";
import { linkCode } from "../core/code/links";
import { applyStatus, computeStatus, setStatuses } from "../core/code/status";
import { reindex } from "../core/index/index";

/** `cube status`: recomputes fingerprints and missing names (no tokens) and marks boxes. */
export async function status(opts: { cwd?: string; json?: boolean; write?: boolean }): Promise<string[] | string> {
  const root = findProjectRoot(opts.cwd);
  const results = computeStatus(root);
  if (opts.json) return JSON.stringify(results, null, 2);
  let changed = 0;
  if (opts.write !== false) {
    changed = applyStatus(root, results);
    if (changed) await reindex(root);
  }
  if (!results.length) return ["Every box matches its code."];
  const stale = results.filter((r) => r.status === "stale");
  const review = results.filter((r) => r.status === "needs-review");
  const out: string[] = [];
  if (review.length) {
    out.push(`Needs review (${review.length}): a code name they mention is gone`);
    for (const r of review) out.push(`  ${r.id} ${r.name}: ${r.reasons.join("; ")}`);
  }
  if (stale.length) {
    out.push(`Stale (${stale.length}): their code changed since they were written`);
    for (const r of stale) out.push(`  ${r.id} ${r.name}: ${r.reasons.join("; ")}`);
  }
  out.push(changed ? `Marked ${changed} box${changed === 1 ? "" : "es"}.` : "", `After checking a box against the code (and updating it if needed), run \`${TOOL_COMMAND} ok <id>\`.`);
  return out.filter(Boolean);
}

/** `cube ok <id...>`: the box was checked; refresh its code links and fingerprints and mark it ok. */
export async function ok(ids: string[], opts: { cwd?: string }): Promise<string[]> {
  const root = findProjectRoot(opts.cwd);
  const cube = loadCube(root);
  const boxes = ids.map((id) => {
    const b = getBox(cube, id);
    if (!b) throw new CubeError(`No box ${id}.`);
    return b;
  });
  linkCode(root, boxes.map((b) => b.id));
  setStatuses(root, new Map(boxes.filter((b) => b.header?.status === "stale" || b.header?.status === "needs-review").map((b) => [b.id, { status: "ok" as const }])));
  await reindex(root);
  return boxes.map((b) => `${b.id} ${b.name}: code links and fingerprints refreshed; status ok.`);
}

/** `cube links [id...]`: re-run code linking. */
export async function links(ids: string[], opts: { cwd?: string }): Promise<string[]> {
  const root = findProjectRoot(opts.cwd);
  const r = linkCode(root, ids.length ? ids : undefined);
  await reindex(root);
  return [`Linked ${r.withCode} of ${r.boxes} boxes to code${r.historyWithCommits ? `, and ${r.historyWithCommits} history entries to commits` : ""}.`];
}
