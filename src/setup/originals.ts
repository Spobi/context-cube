import { getRow, loadCube } from "../core/cube";
import { TOOL_COMMAND } from "../core/paths";
import { bulkUpdateHeaders, createBox } from "../core/ops";
import { splitGenerated } from "../core/format/generated";
import { slugify } from "../core/format/names";
import { isAgentFile } from "../core/logs/memoryFiles";
import type { SourceHome } from "../core/archive";

/**
 * Setup's offer to rewrite rules that point at migrated files ("read
 * HISTORY.md at the start of work") so they point at the cube's rows instead
 * (plan 7.4). Archiving the files themselves is in core/archive.ts.
 */

export interface RuleRewrite {
  box: string;
  oldText: string;
  newText: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rules that name a migrated file, rewritten to name its row in the cube instead. */
export function ruleRewrites(root: string, homes: SourceHome[]): RuleRewrite[] {
  const cube = loadCube(root);
  const rules = cube.rows.find((r) => r.type === "rules");
  if (!rules) return [];
  const out: RuleRewrite[] = [];
  for (const b of rules.boxes) {
    if (b.header?.scope?.startsWith("superseded")) continue;
    const text = splitGenerated(b.doc?.body ?? "").own;
    let next = text;
    const types = new Set<string>();
    for (const h of homes) {
      if (isAgentFile(h.path)) continue;
      const base = h.path.split("/").pop()!;
      // "**Read `HISTORY.md`** (repo root)": keep the emphasis, drop where the file was.
      const re = new RegExp(`\`?(?:[\\w./-]*/)?${esc(base)}\`?(\\*\\*|\\*|__|_)?(?:\\s*\\((?:repo root|this folder|root)\\))?`, "g");
      const before = next;
      next = next.replace(re, (_m, em?: string) => `the cube's ${h.rowName} row (${h.rowId})${em ?? ""}`);
      if (next !== before) types.add(getRow(cube, h.rowId)?.type ?? "");
    }
    // A rule to update a file now means a cube command: say which.
    if (next !== text && /\b(update|add|append|write|record|log|document)\b/i.test(text)) {
      const how = [
        types.has("history") ? `history with \`${TOOL_COMMAND} history add "<what changed>"\`` : "",
        types.has("invariants") ? `invariants with \`${TOOL_COMMAND} propose new\` or \`propose edit\` (a person approves)` : "",
      ].filter(Boolean);
      if (how.length) next = `${next.replace(/\s+$/, "")} (In the cube: add ${how.join("; ")}.)\n`;
    }
    if (next !== text) out.push({ box: b.id, oldText: text, newText: next });
  }
  return out;
}

/** Keeps each old rule word for word (no longer loaded) and adds the rewritten one. */
export function applyRuleRewrites(root: string, rewrites: RuleRewrite[]): string[] {
  const created: string[] = [];
  const cube = loadCube(root);
  const rulesRow = cube.rows.find((r) => r.type === "rules")!;
  for (const rw of rewrites) {
    const first = rw.newText.replace(/^(?:[-*+]|\d+[.)])\s+/, "").split("\n")[0].replace(/\*\*/g, "");
    const box = createBox(root, rulesRow.num, {
      name: slugify(first),
      summary: first.slice(0, 200),
      readWhen: "Always.",
      body: rw.newText,
      writtenBy: "migrated",
      source: `rewritten from ${rw.box} to point at the cube`,
    });
    created.push(box.id);
    bulkUpdateHeaders(root, new Map([[rw.box, { scope: `superseded by ${box.id} (the original words, kept; not loaded)` }]]));
  }
  return created;
}
