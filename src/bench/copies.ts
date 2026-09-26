import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { ensureDir, exists, isDir, normalizeEol, readTextOr, remove, writeText } from "../core/fsutil";
import { git } from "../core/git";
import { CUBE_DIR } from "../core/paths";
import { loadRecipe } from "../core/build/recipe";
import { archivePath, isArchived, stripToolText } from "../core/build/sources";
import { removeBlock, hasBlock } from "../core/index/block";
import { loadConfig, saveConfig } from "../core/config";
import { installHooks } from "../adapters/claude-code/hooks";
import { installTool } from "../core/tool";
import { archiveSources } from "../core/archive";

/**
 * The two copies for the A/B experiment (Phase 9): git worktrees at the same
 * commit. The files copy has the current setup (the original memory files, no
 * cube). The cube copy has the cube and its block, with the original files
 * archived (their content lives in the cube), as setup leaves a real project. Each copy's preparation is
 * committed on a detached HEAD inside the worktree, so resetting between runs
 * returns to it exactly.
 */

export interface Copies {
  base: string;
  dir: string;
  files: { path: string; prep: string };
  cube: { path: string; prep: string };
}

export function copiesDir(root: string): string {
  const id = createHash("sha1").update(root).digest("hex").slice(0, 8);
  return join(tmpdir(), "context-cube-bench", `${basename(root)}-${id}`);
}

function run(args: string[], cwd: string): string {
  const r = git(args, cwd);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function commitPrep(path: string, message: string): string {
  run(["add", "-A"], path);
  run(["-c", "user.name=cube-bench", "-c", "user.email=bench@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "--allow-empty", "-m", message], path);
  return run(["rev-parse", "HEAD"], path);
}

export function removeCopies(root: string): void {
  const dir = copiesDir(root);
  for (const name of ["files", "cube"]) {
    const p = join(dir, name);
    if (isDir(p)) git(["worktree", "remove", "--force", p], root);
  }
  git(["worktree", "prune"], root);
  remove(dir);
}

export function prepareCopies(root: string, ref = "HEAD"): Copies {
  const base = run(["rev-parse", ref], root);
  removeCopies(root);
  const dir = copiesDir(root);
  const files = join(dir, "files");
  const cube = join(dir, "cube");
  run(["worktree", "add", "--detach", files, base], root);
  run(["worktree", "add", "--detach", cube, base], root);
  if (!isDir(join(cube, CUBE_DIR))) throw new Error(`The commit ${base.slice(0, 8)} has no committed cube. Commit context-cube/ first, then run the bench.`);
  const recipe = loadRecipe(root);
  const sources = recipe?.sources.map((s) => s.path) ?? [];

  // Files copy: the original memory files as they were, no cube, no cube rules or helpers.
  for (const p of sources) {
    const snap = archivePath(files, p);
    const abs = join(files, p);
    if (exists(snap)) {
      ensureDir(dirname(abs));
      writeFileSync(abs, readFileSync(snap));
    } else if (exists(abs)) writeText(abs, stripToolText(normalizeEol(readTextOr(abs, ""))));
  }
  for (const f of ["CLAUDE.md", "AGENTS.md"]) {
    const abs = join(files, f);
    const text = readTextOr(abs, "");
    if (hasBlock(text)) {
      const next = removeBlock(text);
      if (next.trim()) writeText(abs, next);
      else remove(abs);
    }
  }
  for (const d of [".claude/rules", ".claude/agents", ".claude/commands"]) {
    const abs = join(files, d);
    if (!isDir(abs)) continue;
    for (const f of readdirSync(abs)) if (/^cube-/.test(f)) remove(join(abs, f));
  }
  remove(join(files, CUBE_DIR));
  // The logger needs the tool; it goes in the prep commit so resets keep it (logs themselves are ignored).
  installTool(files);
  installHooks(files, { features: ["log"], scope: "local" });
  const filesPrep = commitPrep(files, "bench: files copy (current setup, no cube)");

  // Cube copy: the cube, with the original memory files archived, as setup leaves a real project.
  archiveSources(cube, sources.filter((p) => !isArchived(cube, p)));
  // Bench runs measure the task itself: no automatic cube updates inside them.
  const c = loadConfig(cube);
  c.update.trigger = "manual";
  saveConfig(cube, c);
  installTool(cube);
  installHooks(cube, { features: ["guard", "log", "session"], scope: "local" });
  const cubePrep = commitPrep(cube, "bench: cube copy (cube, original files archived)");
  return { base, dir, files: { path: files, prep: filesPrep }, cube: { path: cube, prep: cubePrep } };
}

/** Back to the prepared state: tracked changes undone, new files removed (logs are kept). */
export function resetCopy(path: string, prep: string): void {
  run(["reset", "-q", "--hard", prep], path);
  run(["clean", "-q", "-fd"], path);
}
