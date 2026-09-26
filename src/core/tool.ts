import { closeSync, copyFileSync, chmodSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, exists, isFile, writeText } from "./fsutil";
import { cubePaths, findProjectRoot, TOOL_COMMAND } from "./paths";
import { CubeError } from "./ops";

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

/** Compares release versions ("0.2.0" < "0.10.0"). A version with a suffix ("0.0.0-dev") compares by its numbers. */
export function compareVersions(a: string, b: string): number {
  const nums = (v: string) => v.split("-")[0].split(".").map((n) => Number(n) || 0);
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** The version a bundled tool file declares on its second line. */
export function bundleVersion(path: string): string | undefined {
  if (!isFile(path)) return undefined;
  const buf = Buffer.alloc(512);
  const fd = openSync(path, "r");
  try {
    const n = readSync(fd, buf, 0, buf.length, 0);
    return /__CUBE_TOOL_VERSION__\s*=\s*"([^"]+)"/.exec(buf.toString("utf8", 0, n))?.[1];
  } finally {
    closeSync(fd);
  }
}

export function readToolVersion(root: string): string | undefined {
  return bundleVersion(cubePaths(root).toolFile);
}

/**
 * Why this run should stop: the project's own copy of the tool is newer than
 * the one running, which might misread or undo what the newer one wrote.
 * Undefined when running the project's copy, or when either version is unknown.
 */
export function olderThanProject(cwd: string, running: string = version(), self: string | undefined = bundlePath()): string | undefined {
  if (running.includes("-")) return undefined;
  const root = findProjectRoot(cwd);
  const copy = cubePaths(root).toolFile;
  if (self && resolve(self) === resolve(copy)) return undefined;
  const theirs = bundleVersion(copy);
  if (!theirs || compareVersions(running, theirs) >= 0) return undefined;
  return `This project uses Context Cube ${theirs}, and you ran ${running}, an older version that could misread it. Run the project's own copy instead (${TOOL_COMMAND} <command>), or update: npx context-cube@latest`;
}

export interface ToolInstall {
  cubeDirCreated: boolean;
  gitignoreCreated: boolean;
  toolCreated: boolean;
  /** The version the project's copy had, when this install replaced it with a newer one. */
  updatedFrom?: string;
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
    const [from, to] = [bundleVersion(p.toolFile), bundleVersion(src)];
    if (!same && from && to && compareVersions(to, from) < 0) {
      throw new CubeError(`This project uses Context Cube ${from}, newer than this one (${to}), so its copy wasn't replaced. Update: npx context-cube@latest`);
    }
    if (!same && from && to && compareVersions(to, from) > 0) result.updatedFrom = from;
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
