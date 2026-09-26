import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, exists, isDir, remove, writeIfChanged } from "../../core/fsutil";
import { emptyManifest, loadManifest, saveManifest } from "../../core/installs";
import type { PathRule } from "../types";
import { ADAPTER_ID } from "./hooks";

/**
 * Writes path-scoped rule files (.claude/rules/cube-*.md with `paths:`) and
 * removes ones no longer needed. Verified 2026-09-23 (plan 18): a matching
 * Read loads the rule, and InstructionsLoaded reports load_reason
 * "path_glob_match". Only files named cube-*.md are ever touched.
 */
export function rulesDir(root: string): string {
  return join(root, ".claude", "rules");
}

function render(rule: PathRule): string {
  const paths = rule.paths.map((p) => `  - ${JSON.stringify(p)}`).join("\n");
  return `---\npaths:\n${paths}\n---\n${rule.body}`;
}

export function installPathRules(root: string, rules: PathRule[]): void {
  const dir = rulesDir(root);
  const had = readdirSafe(dir);
  const want = new Set(rules.map((r) => `${r.id}.md`));
  for (const f of had) if (/^cube-.*\.md$/.test(f) && !want.has(f)) remove(join(dir, f));
  if (!rules.length) {
    pruneIfCreated(root);
    return;
  }
  const manifest = loadManifest(root, ADAPTER_ID, "shared") ?? emptyManifest(ADAPTER_ID, "shared");
  const claudeExisted = isDir(join(root, ".claude"));
  const rulesExisted = isDir(dir);
  if (!rulesExisted) {
    ensureDir(dir);
    const dirs = new Set(manifest.dirs);
    if (!claudeExisted) dirs.add(".claude");
    dirs.add(".claude/rules");
    manifest.dirs = [...dirs];
    saveManifest(root, manifest);
  }
  for (const r of rules) writeIfChanged(join(dir, `${r.id}.md`), render(r));
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Removes .claude/rules (and .claude) if this tool created them and they're now empty. */
export function pruneIfCreated(root: string): void {
  const manifest = loadManifest(root, ADAPTER_ID, "shared");
  if (!manifest) return;
  for (const d of [".claude/rules", ".claude"]) {
    const abs = join(root, d);
    if (manifest.dirs.includes(d) && isDir(abs) && readdirSafe(abs).length === 0) remove(abs);
  }
  manifest.dirs = manifest.dirs.filter((d) => exists(join(root, d)));
  saveManifest(root, manifest);
}

export function removeAllPathRules(root: string): void {
  installPathRules(root, []);
}
