import { allBoxes, loadCube } from "../cube";
import { loadBoxState } from "../state/state";
import { TOOL_COMMAND } from "../paths";
import { computeStatus, recentFiles } from "./status";

/**
 * The session-start notice (plan 8.4): stale or needs-review boxes linked to
 * recent work (uncommitted changes and the last few commits), one line each.
 * Read-only: it never edits the cube.
 */
export function sessionNotice(root: string, max = 8): string | undefined {
  const cube = loadCube(root);
  if (!cube.rows.length) return undefined;
  const recent = recentFiles(root);
  if (!recent.size) return undefined;
  const found = new Map<string, string>();
  for (const s of computeStatus(root, { onlyFiles: recent, cube })) found.set(s.id, `${s.id} ${s.name} (${s.status}: ${s.reasons.slice(0, 2).join("; ")})`);
  for (const b of allBoxes(cube)) {
    const st = b.header?.status;
    if (found.has(b.id) || (st !== "stale" && st !== "needs-review")) continue;
    const files = Object.keys(loadBoxState(root, b.id)?.fingerprints ?? {});
    if (files.some((f) => recent.has(f))) found.set(b.id, `${b.id} ${b.name} (marked ${st})`);
  }
  if (!found.size) return undefined;
  const lines = [...found.values()];
  const shown = lines.slice(0, max);
  return [
    `Context Cube: ${lines.length} box${lines.length === 1 ? "" : "es"} linked to recent work may be out of date:`,
    ...shown.map((l) => `- ${l}`),
    ...(lines.length > max ? [`- …and ${lines.length - max} more (run \`${TOOL_COMMAND} status\`)`] : []),
    `Check a box against the code before relying on it; an invariant still holds, so check the code still follows it. After reviewing or updating a box, run \`${TOOL_COMMAND} ok <id>\`.`,
  ].join("\n");
}
