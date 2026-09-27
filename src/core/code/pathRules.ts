import type { Box, Cube } from "../cube";
import { splitGenerated } from "../format/generated";
import { governingByFile, STRONG } from "./governs";
import type { PathRule } from "../../adapters/types";

/**
 * Surfacing invariants (plan 8.5): for each approved invariant, a rule that
 * appears when the agent works with the files it governs, so the most
 * important rules find the agent instead of the agent looking for them. Only
 * invariants: a note's summary (an old plan, say) isn't a rule and never loads
 * as one. Files come from governingByFile, counting only clear links.
 * Pending invariants are candidates a person hasn't approved, so they never get
 * a rule: an unapproved rule must not be enforced.
 */
export function pathRulesFor(cube: Cube): PathRule[] {
  const rules: PathRule[] = [];
  const files = new Map<string, { inv: Box; files: string[] }>();
  for (const [file, list] of governingByFile(cube)) {
    for (const g of list) {
      if (g.score < STRONG) continue;
      const e = files.get(g.inv.id) ?? { inv: g.inv, files: [] };
      e.files.push(file);
      files.set(g.inv.id, e);
    }
  }
  for (const { inv, files: paths } of [...files.values()].sort((a, b) => a.inv.id.localeCompare(b.inv.id))) {
    // One line each: a central file can load a dozen of these.
    const lines = [`Context Cube: before editing this file, open invariant ${inv.id}, a rule that must never be broken: ${inv.header!.summary} → context-cube/${inv.relDir}/Z1-invariants.md`];
    // Stale means "verify", never "ignore": an invariant still holds when its code changes.
    const st = inv.header!.status;
    if (st === "stale" || st === "needs-review") lines.push("Its code changed since it was last checked. It still holds; check that the code still follows it.");
    rules.push({ id: `cube-${inv.id.replace(".", "-")}`, paths: paths.sort(), body: `${lines.join("\n")}\n` });
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

/**
 * Glob matching for rule paths, relative to the project root: `**` crosses
 * folders, `*` and `?` don't, `{a,b}` is either. For agents without path-scoped
 * rule files (Codex), whose hooks surface the rules themselves.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else if (ch === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${glob.slice(i + 1, end).split(",").map((alt) => globToRegExp(alt).source.slice(1, -1)).join("|")})`;
        i = end;
      }
    } else re += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** The rules that load for a file (a path relative to the project root). */
export function rulesForFile(rules: PathRule[], rel: string): PathRule[] {
  return rules.filter((r) => r.paths.some((p) => globToRegExp(p.replace(/^\.\//, "")).test(rel)));
}
