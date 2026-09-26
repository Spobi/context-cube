import { copyFileSync, chmodSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, exists, isFile, readTextOr, writeText } from "./fsutil";
import { cubePaths, findProjectRoot } from "./paths";

/** The bundled CLI file that is running now, if we're running from a bundle. */
export function bundlePath(): string | undefined {
  if (process.env.CUBE_BUNDLE_PATH) return resolve(process.env.CUBE_BUNDLE_PATH);
  try {
    const self = fileURLToPath(import.meta.url);
    if (self.endsWith(".mjs") && isFile(self)) return self;
  } catch {
    // not a file URL
  }
  return undefined;
}

export function version(): string {
  return typeof __CUBE_VERSION__ === "string" ? __CUBE_VERSION__ : "0.0.0-dev";
}

export interface ToolInstall {
  cubeDirCreated: boolean;
  gitignoreCreated: boolean;
  toolCreated: boolean;
}

/**
 * Copies the running CLI into the project as context-cube/.tool/cube.mjs, so hooks
 * and agents can run it with only Node installed, and writes context-cube/.gitignore.
 */
export function installTool(root: string): ToolInstall {
  const p = cubePaths(root);
  const result: ToolInstall = { cubeDirCreated: !exists(p.cube), gitignoreCreated: false, toolCreated: false };
  ensureDir(p.cube);
  const gitignore = join(p.cube, ".gitignore");
  if (!exists(gitignore)) {
    writeText(gitignore, ".logs/\n");
    result.gitignoreCreated = true;
  }
  const src = bundlePath();
  if (!src) throw new Error("Can't find the bundled tool to copy. Build it first with `npm run build`.");
  result.toolCreated = !exists(p.toolFile);
  if (resolve(src) !== resolve(p.toolFile)) {
    const same = exists(p.toolFile) && readFileSync(p.toolFile).equals(readFileSync(src));
    if (!same) {
      ensureDir(p.tool);
      copyFileSync(src, p.toolFile);
      chmodSync(p.toolFile, 0o755);
    }
  }
  return result;
}

/**
 * context-cube/.ignore keeps the cube's bookkeeping (per-box state full of code
 * names, the bundled tool, logs) out of ripgrep-based code searches, including
 * Claude Code's Grep and Glob. The drawers stay searchable, and `cube find`
 * searches them on purpose. Written once; a person may edit it.
 */
export const SEARCH_IGNORE = "# Keeps Context Cube's bookkeeping out of code searches (ripgrep and tools built on it).\n.state/\n.tool/\n.logs/\n";

export function writeSearchIgnore(root: string): void {
  const p = join(cubePaths(root).cube, ".ignore");
  if (!exists(p)) writeText(p, SEARCH_IGNORE);
}

/**
 * The project root for a hook: if we're running from <root>/context-cube/.tool/cube.mjs,
 * that root; otherwise the project containing CLAUDE_PROJECT_DIR or the hook's cwd.
 */
export function hookRoot(cwd?: string): string {
  const self = bundlePath();
  const marker = `${sep}context-cube${sep}.tool${sep}cube.mjs`;
  if (self && self.endsWith(marker) && !process.env.CUBE_BUNDLE_PATH) {
    return dirname(dirname(dirname(self)));
  }
  return findProjectRoot(process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd());
}

export function readToolVersion(root: string): string | undefined {
  const text = readTextOr(cubePaths(root).toolFile, "");
  const m = /__CUBE_TOOL_VERSION__\s*=\s*"([^"]+)"/.exec(text);
  return m?.[1];
}
