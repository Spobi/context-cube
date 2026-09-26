import { dirname, join, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { isDir } from "./fsutil";
import { gitRoot } from "./git";

export const CUBE_DIR = "context-cube";

/**
 * The project root: the git root, or (without git) the nearest folder above
 * `start` that already has a cube, or `start` itself.
 */
export function findProjectRoot(start: string = process.cwd()): string {
  const abs = resolve(start);
  const g = gitRoot(abs);
  if (g) return realpath(g);
  let dir = abs;
  for (;;) {
    if (isDir(join(dir, CUBE_DIR))) return realpath(dir);
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return realpath(abs);
}

export function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export interface CubePaths {
  root: string;
  cube: string;
  config: string;
  recipe: string;
  cubeMd: string;
  state: string;
  boxesState: string;
  retired: string;
  aliases: string;
  approvals: string;
  pending: string;
  archive: string;
  logs: string;
  tool: string;
  toolFile: string;
}

export function cubePaths(root: string): CubePaths {
  const cube = join(root, CUBE_DIR);
  const state = join(cube, ".state");
  return {
    root,
    cube,
    config: join(cube, "cube.config.json"),
    recipe: join(cube, "recipe.json"),
    cubeMd: join(cube, "CUBE.md"),
    state,
    boxesState: join(state, "boxes"),
    retired: join(state, "retired.txt"),
    aliases: join(state, "aliases.txt"),
    approvals: join(state, "approvals.log"),
    pending: join(state, "pending"),
    archive: join(state, "archive"),
    logs: join(cube, ".logs"),
    tool: join(cube, ".tool"),
    toolFile: join(cube, ".tool", "cube.mjs"),
  };
}

/** Path relative to the project root, with forward slashes; absolute if outside. */
export function relToRoot(root: string, file: string): string {
  const abs = resolve(root, file);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || resolve(rel) === rel) return abs.split(sep).join("/");
  return rel.split(sep).join("/");
}

/** The command agents and hooks use to run the project's copy of the tool. */
export const TOOL_COMMAND = "node context-cube/.tool/cube.mjs";
