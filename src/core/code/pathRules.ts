import { allBoxes, getBox, getRow, isCandidate, type Cube } from "../cube";
import { loadBoxState } from "../state/state";
import { splitGenerated } from "../format/generated";
import { TOOL_COMMAND } from "../paths";
import type { PathRule } from "../../adapters/types";

/**
 * Surfacing invariants (plan 8.5): for each box with invariants and code
 * paths, a rule that appears when the agent works with those files, so the
 * most important rules find the agent instead of the agent looking for them.
 * Pending invariants are candidates a person hasn't approved, so they never get
 * a rule: an unapproved rule must not be enforced.
 */
export function pathRulesFor(cube: Cube): PathRule[] {
  const rules: PathRule[] = [];
  for (const box of allBoxes(cube)) {
    if (box.isRoot || !box.header || isCandidate(box)) continue;
    const row = getRow(cube, box.rowNum)!;
    if (row.type === "history") continue;
    const files = (loadBoxState(cube.root, box.id)?.code?.files ?? []).map((f) => f.path);
    if (!files.length) continue;
    const invLinks = box.header.links
      .map((l) => getBox(cube, l.to))
      .filter((t) => t && getRow(cube, t.rowNum)?.type === "invariants" && t.id !== box.id && !isCandidate(t));
    const own = row.type === "invariants";
    if (!own && !invLinks.length) continue;
    const z1 = (id: string, rel: string) => `- ${id}: context-cube/${rel}/Z1-invariants.md`;
    const lines = [`Context Cube: ${box.id} ${box.name} covers this file.`, box.header.summary, ""];
    if (own) {
      lines.push(`These are invariants: rules that must never be broken. Before editing this file, open ${box.id} Z1:`, z1(box.id, box.relDir));
    } else {
      lines.push("It is governed by invariants. Before editing this file, open their Z1:");
      for (const t of invLinks) lines.push(z1(t!.id, t!.relDir));
    }
    // Stale means "verify", never "ignore": an invariant still holds when its code changes.
    const st = box.header.status;
    if (st === "stale" || st === "needs-review") {
      lines.push("", own
        ? "Its code changed since these invariants were last checked against it. They still hold; check that the code still follows them."
        : `${box.id} is marked ${st}: its code changed since it was last checked. Check its description against the code before relying on it.`);
    }
    lines.push("", `More: context-cube/${box.relDir}/ · Everything linked to this file: ${TOOL_COMMAND} related <file>`);
    rules.push({ id: `cube-${box.id.replace(".", "-")}`, paths: files, body: `${lines.join("\n")}\n` });
  }
  // Rules scoped to files load with those files instead of every session (limits.blockTokens).
  for (const b of cube.rows.find((r) => r.type === "rules")?.boxes ?? []) {
    const paths = b.header?.paths;
    if (!paths?.length || b.header?.scope?.startsWith("superseded")) continue;
    const text = (b.doc ? splitGenerated(b.doc.body).own.trim() : "") || b.header!.summary;
    rules.push({ id: `cube-${b.id.replace(".", "-")}`, paths, body: `Context Cube rule ${b.id}, for these files:\n${text}\n` });
  }
  return rules;
}
