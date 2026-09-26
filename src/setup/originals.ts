import { loadCube } from "../core/cube";
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
    for (const h of homes) {
      if (isAgentFile(h.path)) continue;
      const base = h.path.split("/").pop()!;
      const re = new RegExp(`\`?(?:[\\w./-]*/)?${esc(base)}\`?(\\s*\\((?:repo root|this folder|root)\\))?`, "g");
      next = next.replace(re, `the cube's ${h.rowName} row (${h.rowId})`);
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
