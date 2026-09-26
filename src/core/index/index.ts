import { writeIfChanged } from "../fsutil";
import { loadCube, type Cube } from "../cube";
import { loadConfig, type CubeConfig } from "../config";
import { splitGenerated } from "../format/generated";
import { syncLinkNames } from "../ops";
import { adaptersFor } from "../../adapters/registry";
import { writeGenerated } from "./backlinks";
import { cubeMd, rowListLine, writeRowPages } from "./pages";
import { pathRulesFor } from "../code/pathRules";
import { estimateTokens } from "../tokens";
import { TOOL_COMMAND } from "../paths";

export interface RuleText {
  id: string;
  text: string;
  /** Set when the rule loads only with matching files, not in the always-loaded block. */
  paths?: string[];
}

export function ruleText(cube: Cube): RuleText[] {
  const rules = cube.rows.find((r) => r.type === "rules");
  if (!rules) return [];
  return rules.boxes.filter((b) => !b.header?.scope?.startsWith("superseded")).map((b) => {
    const body = b.doc ? splitGenerated(b.doc.body).own.trim() : "";
    return { id: b.id, text: body || b.header?.summary || b.name, paths: b.header?.paths?.length ? b.header.paths : undefined };
  });
}

function blockText(cube: Cube, config: CubeConfig, compact: boolean): string {
  const cpt = config.tokens.charsPerToken;
  const lines = [
    "## Project memory (Context Cube)",
    "The rules below always apply. For everything else, pick rows from the list, open their row index, and open only the drawers your task needs. Full protocol: context-cube/CUBE.md",
    `Before changing a file, \`${TOOL_COMMAND} related <file>\` lists the invariants, boxes, and history linked to it. To search the memory: \`${TOOL_COMMAND} find <words>\`.`,
    "",
    "### Rules",
  ];
  const all = ruleText(cube);
  const rules = all.filter((r) => !r.paths);
  const scoped = all.length - rules.length;
  if (!all.length) lines.push("(none yet)");
  for (const r of rules) {
    // The rule is stored word for word; only this display drops its own list marker.
    const [first, ...rest] = r.text.replace(/^(?:[-*+]|\d+[.)]|#{1,6})\s+/, "").split("\n");
    lines.push(`- ${r.id} ${first}`, ...rest.map((l) => (l.trim() ? `  ${l}` : "")));
  }
  if (scoped) lines.push(`- (${scoped} more rule${scoped === 1 ? " loads" : "s load"} only when you work with the files ${scoped === 1 ? "it covers" : "they cover"}.)`);
  lines.push("", "### Rows");
  const rows = cube.rows.filter((r) => r.type !== "rules");
  if (!rows.length) lines.push("(none yet)");
  // No box counts or sizes here: CLAUDE.md then changes only when rows or rules do,
  // so teammates' branches rarely conflict in it. CUBE.md has the sizes.
  for (const row of rows) lines.push(rowListLine(row, cpt, "context-cube/", false, compact));
  if (compact && rows.length) lines.push("What each row holds: context-cube/CUBE.md");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * The block the adapter writes into CLAUDE.md / AGENTS.md (plan 3.8). It is read
 * at the start of every session, so it has a ceiling (limits.blockTokens): above
 * it, the row list keeps only when to open each row. `cube check` warns when it's
 * over, and suggests rules that could load only with their files.
 */
export function alwaysLoadedBlock(cube: Cube, config: CubeConfig): string {
  const full = blockText(cube, config, false);
  if (estimateTokens(full.length, config.tokens.charsPerToken) <= config.limits.blockTokens) return full;
  return blockText(cube, config, true);
}

export interface IndexResult {
  filesChanged: number;
  rows: number;
  boxes: number;
}

/** Regenerates backlinks, row index pages, CUBE.md, and the always-loaded block. */
export async function reindex(root: string, opts: { adapters?: boolean } = {}): Promise<IndexResult> {
  const config = loadConfig(root);
  syncLinkNames(root);
  let changed = writeGenerated(loadCube(root));
  const cube = loadCube(root);
  for (const row of cube.rows) changed += writeRowPages(row, config);
  if (writeIfChanged(cube.paths.cubeMd, cubeMd(cube, config))) changed++;
  if (opts.adapters !== false && cube.rows.length) {
    const block = alwaysLoadedBlock(cube, config);
    const rules = pathRulesFor(cube);
    for (const a of adaptersFor(config.agents)) {
      await a.writeAlwaysLoadedBlock(root, block);
      if (a.capabilities.pathRules) await a.installPathRules(root, rules);
    }
  }
  return { filesChanged: changed, rows: cube.rows.length, boxes: cube.rows.reduce((s, r) => s + r.boxes.length, 0) };
}
