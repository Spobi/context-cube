import { openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import fg from "fast-glob";
import { git, gitRoot } from "./git";
import { CUBE_DIR } from "./paths";

/** Folders that hold dependencies or build output in common ecosystems. */
export const SKIP_DIRS = [
  "node_modules",
  ".git",
  "vendor",
  "Pods",
  "Carthage",
  ".build",
  "DerivedData",
  "build",
  "dist",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".gradle",
  ".idea",
  "coverage",
  CUBE_DIR,
];

const SKIP_SET = new Set(SKIP_DIRS);

/** Lists project files (relative, forward slashes): git-tracked plus untracked-but-not-ignored. */
export function listProjectFiles(root: string): string[] {
  let files: string[];
  if (gitRoot(root)) {
    const r = git(["ls-files", "-co", "--exclude-standard", "-z"], root);
    files = r.stdout.split("\0").filter(Boolean);
  } else {
    files = fg.sync("**/*", {
      cwd: root,
      dot: true,
      onlyFiles: true,
      ignore: SKIP_DIRS.map((d) => `**/${d}/**`),
      followSymbolicLinks: false,
    });
  }
  return files.filter((f) => !f.split("/").some((part) => SKIP_SET.has(part))).sort();
}

/** True when the file looks binary (a NUL byte in its first 8 KB). */
export function isBinary(abs: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(abs, "r");
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function fileSize(abs: string): number {
  try {
    return statSync(abs).size;
  } catch {
    return 0;
  }
}

export function isMarkdown(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

export function absPath(root: string, rel: string): string {
  return join(root, rel);
}
