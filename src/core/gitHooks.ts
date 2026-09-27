import { chmodSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { exists, readTextOr, remove, writeText } from "./fsutil";
import { git, gitRoot } from "./git";
import { emptyManifest, loadManifest, saveManifest } from "./installs";

/**
 * The git pre-commit check (plan 9.2, layer 2): compares invariant text against
 * approved checksums, catching edits made any other way (an editor, a script,
 * another agent). A marked block is added to the pre-commit hook; nothing else
 * in an existing hook is touched.
 */

const START = "# >>> context-cube >>>";
const END = "# <<< context-cube <<<";
const BLOCK = [
  START,
  "# Blocks commits that change invariant text without approval. See: node context-cube/.tool/cube.mjs pending",
  'if [ -f "$(git rev-parse --show-toplevel)/context-cube/.tool/cube.mjs" ]; then',
  '  node "$(git rev-parse --show-toplevel)/context-cube/.tool/cube.mjs" check --invariants || exit 1',
  "fi",
  END,
].join("\n");

export function hooksDir(root: string): string | undefined {
  if (!gitRoot(root)) return undefined;
  const custom = git(["config", "--get", "core.hooksPath"], root).stdout.trim();
  if (custom) return isAbsolute(custom) ? custom : join(root, custom);
  const dir = git(["rev-parse", "--git-path", "hooks"], root).stdout.trim();
  return isAbsolute(dir) ? dir : join(root, dir);
}

const AFTER_MERGE = [
  START,
  "# After a merge or rebase: renumber duplicate boxes and rebuild generated files.",
  'if [ -f "$(git rev-parse --show-toplevel)/context-cube/.tool/cube.mjs" ]; then',
  '  node "$(git rev-parse --show-toplevel)/context-cube/.tool/cube.mjs" check --fix >/dev/null 2>&1',
  '  node "$(git rev-parse --show-toplevel)/context-cube/.tool/cube.mjs" index >/dev/null 2>&1',
  "fi",
  END,
].join("\n");

function installHookBlock(root: string, name: string, block: string): string | undefined {
  const dir = hooksDir(root);
  if (!dir) return undefined;
  const path = join(dir, name);
  const existed = exists(path);
  const text = readTextOr(path, "");
  if (text.includes(START)) return path;
  writeText(path, existed ? `${text.replace(/\n*$/, "\n")}\n${block}\n` : `#!/bin/sh\n${block}\n`);
  chmodSync(path, 0o755);
  const m = loadManifest(root, "git", "local") ?? emptyManifest("git", "local");
  m.features = [...new Set([...m.features, name])];
  const hooks = ((m as any).hooks ?? {}) as Record<string, { created: boolean; originalText?: string }>;
  hooks[name] = { created: !existed, originalText: existed ? text : undefined };
  (m as any).hooks = hooks;
  saveManifest(root, m);
  return path;
}

function removeHookBlock(root: string, name: string): void {
  const dir = hooksDir(root);
  if (!dir) return;
  const path = join(dir, name);
  const text = readTextOr(path, "");
  if (!text.includes(START)) return;
  const info = ((loadManifest(root, "git", "local") as any)?.hooks ?? {})[name] as { created: boolean; originalText?: string } | undefined;
  if (info?.created) remove(path);
  else if (info?.originalText !== undefined) writeText(path, info.originalText);
  else {
    const s = text.indexOf(START);
    const e = text.indexOf(END);
    writeText(path, (text.slice(0, s).replace(/\n+$/, "\n") + text.slice(e + END.length).replace(/^\n+/, "")).replace(/\n*$/, "\n"));
  }
}

/** Whether this clone's hook `name` has the cube's block. */
export function hasHookBlock(root: string, name: string): boolean {
  const dir = hooksDir(root);
  return !!dir && readTextOr(join(dir, name), "").includes(START);
}

/** Whether the hooks folder is the project's own, tracked in git (husky and the like): changing it changes the project. */
export function hooksFolderTracked(root: string): boolean {
  const dir = hooksDir(root);
  if (!dir) return false;
  const r = git(["ls-files", "--", dir], root);
  return r.ok && !!r.stdout.trim();
}

/** Git hooks for teams: renumber duplicates and rebuild generated files after merges and rebases (plan 11). */
export function installMergeHooks(root: string): void {
  installHookBlock(root, "post-merge", AFTER_MERGE);
  installHookBlock(root, "post-rewrite", AFTER_MERGE);
}

export function removeMergeHooks(root: string): void {
  removeHookBlock(root, "post-merge");
  removeHookBlock(root, "post-rewrite");
}

export function installPreCommit(root: string): string | undefined {
  const dir = hooksDir(root);
  if (!dir) return undefined;
  const path = join(dir, "pre-commit");
  const existed = exists(path);
  const text = readTextOr(path, "");
  if (text.includes(START)) return path;
  const next = existed ? `${text.replace(/\n*$/, "\n")}\n${BLOCK}\n` : `#!/bin/sh\n${BLOCK}\n`;
  writeText(path, next);
  chmodSync(path, 0o755);
  const m = loadManifest(root, "git", "local") ?? emptyManifest("git", "local");
  m.features = ["pre-commit"];
  m.settings = { path, created: !existed, claudeDirCreated: false, hooksKey: false, events: [], originalText: existed ? text : undefined };
  saveManifest(root, m);
  return path;
}

export function removePreCommit(root: string): void {
  const m = loadManifest(root, "git", "local");
  const dir = hooksDir(root);
  if (!dir) return;
  const path = m?.settings?.path ?? join(dir, "pre-commit");
  const text = readTextOr(path, "");
  if (!text.includes(START)) return;
  if (m?.settings?.created) {
    remove(path);
  } else if (m?.settings?.originalText !== undefined) {
    writeText(path, m.settings.originalText);
  } else {
    const s = text.indexOf(START);
    const e = text.indexOf(END);
    writeText(path, (text.slice(0, s).replace(/\n+$/, "\n") + text.slice(e + END.length).replace(/^\n+/, "")).replace(/\n*$/, "\n"));
  }
}
