import { join } from "node:path";
import { exists, isDir, readTextOr, remove, writeIfChanged } from "../../core/fsutil";
import { emptyManifest, loadManifest, saveManifest } from "../../core/installs";
import { CODEX_ID, PERSON_ONLY_VERBS, removeIfEmpty, TOOL_WORDS } from "./hooks";

/**
 * Codex's command rules (.codex/rules/*.rules, Starlark): the person-only
 * commands get decision "prompt", so Codex asks the person before running one,
 * as Claude Code's "ask" permission rules do. Codex hooks can't ask, so these
 * rules are what asks; the guard hook blocks any person-only command shaped so
 * that these rules might miss it. Like hooks, project rules load only once the
 * person trusts the project's .codex/ folder.
 */

export const RULES_FILE = ".codex/rules/context-cube.rules";
const MARK = "# Context Cube:";

export function rulesText(): string {
  const rules = PERSON_ONLY_VERBS.map((verb) =>
    [
      "prefix_rule(",
      `    pattern = [${[...TOOL_WORDS, ...verb].map((w) => JSON.stringify(w)).join(", ")}],`,
      '    decision = "prompt",',
      `    justification = "Context Cube: ${verb.join(" ")} needs a person's yes.",`,
      ")",
    ].join("\n"),
  );
  return `${MARK} commands that need a person's yes. Written by Context Cube; \`${TOOL_WORDS.join(" ")} uninstall\` removes it.\n\n${rules.join("\n\n")}\n`;
}

export function installCodexRules(root: string): void {
  const manifest = loadManifest(root, CODEX_ID, "shared") ?? emptyManifest(CODEX_ID, "shared");
  const dirs = new Set(manifest.dirs);
  for (const d of [".codex", ".codex/rules"]) if (!isDir(join(root, d))) dirs.add(d);
  const abs = join(root, RULES_FILE);
  if (exists(abs) && !readTextOr(abs, "").startsWith(MARK)) return; // someone else's file with our name: leave it
  if (!exists(abs)) manifest.files = [...new Set([...manifest.files, RULES_FILE])];
  writeIfChanged(abs, rulesText());
  manifest.dirs = [...dirs];
  saveManifest(root, manifest);
}

/** Are the rules that make person-only commands ask in place? */
export function codexRulesInstalled(root: string): boolean {
  return readTextOr(join(root, RULES_FILE), "") === rulesText();
}

export function uninstallCodexRules(root: string): void {
  const manifest = loadManifest(root, CODEX_ID, "shared");
  if (!manifest?.files.includes(RULES_FILE)) return;
  remove(join(root, RULES_FILE));
  manifest.files = manifest.files.filter((f) => f !== RULES_FILE);
  if (manifest.dirs.includes(".codex/rules")) removeIfEmpty(join(root, ".codex/rules"));
  saveManifest(root, manifest);
}
