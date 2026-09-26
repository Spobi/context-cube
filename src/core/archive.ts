import { readFileSync, readdirSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ensureDir, exists, isDir, normalizeEol, readTextOr, remove, writeText } from "./fsutil";
import { cubePaths, relToRoot, TOOL_COMMAND } from "./paths";
import { absPath, fileSize, listProjectFiles } from "./scan";
import { allBoxes, getRow, loadCube } from "./cube";
import { loadBoxState } from "./state/state";
import { extractBlock, upsertBlock } from "./index/block";
import { loadRecipe } from "./build/recipe";
import { placedCoverage } from "./build/coverage";
import { ARCHIVED_END, ARCHIVED_START, archivePath, isArchived, isPlaceholder, stripToolText } from "./build/sources";
import { isAgentFile } from "./logs/memoryFiles";
import { CubeError } from "./ops";

/**
 * The archive. Once a cube holds a source file's text word for word, the
 * original moves, unchanged, to context-cube/.state/archive/<path>, and a short
 * placeholder takes its place saying where the content went. The agent isn't
 * pointed at the archive, code search skips it (.ignore), and the Claude Code
 * adapter denies reading it; a person gets any file back with `cube restore`.
 *
 * Reading a source (readSource) prefers the archived original, so coverage and
 * a later rebuild see the same text before and after archiving.
 */

export interface SourceHome {
  path: string;
  rowId: string;
  rowName: string;
}

/** Where each migrated source's content mostly went. */
export function sourceHomes(root: string, sources: string[]): SourceHome[] {
  const cube = loadCube(root);
  const counts = new Map<string, Map<string, number>>();
  for (const b of allBoxes(cube)) {
    for (const s of loadBoxState(root, b.id)?.sources ?? []) {
      const m = counts.get(s.file) ?? new Map<string, number>();
      const rowId = b.id.split(".")[0];
      m.set(rowId, (m.get(rowId) ?? 0) + (s.end - s.start + 1));
      counts.set(s.file, m);
    }
  }
  return sources.flatMap((path) => {
    const m = counts.get(path);
    if (!m) return [];
    const [rowId] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    return [{ path, rowId, rowName: getRow(cube, rowId)!.name }];
  });
}

/** The text an archived source leaves in its place. */
export function placeholder(path: string, home: SourceHome | undefined, rulesRowId: string): string {
  const restore = `\`${TOOL_COMMAND} restore ${path}\``;
  const body = isAgentFile(path)
    ? [
        "# Project instructions",
        "",
        `This project's instructions now live in its Context Cube (\`context-cube/\`), in the rules row (${rulesRowId}), and load at the start of every session through the project memory block. The original file is kept word for word in the cube's archive; a person can put it back with ${restore}.`,
      ]
    : [
        `# ${path.split("/").pop()} (archived)`,
        "",
        `This file's content now lives in the project's Context Cube (\`context-cube/\`), word for word${home ? `, mostly in its ${home.rowName} row (${home.rowId})` : ""}. Start at \`context-cube/CUBE.md\`, or search it with \`${TOOL_COMMAND} find <words>\`. Add new material through the cube, not here.`,
        "",
        `The original file is kept in the cube's archive; a person can put it back with ${restore}.`,
      ];
  return `${ARCHIVED_START}\n${body.join("\n")}\n${ARCHIVED_END}\n`;
}

/** Text in an archived source's file that isn't the placeholder or the block: added after archiving. */
export function addedText(root: string, path: string): string {
  const abs = absPath(root, path);
  return exists(abs) ? stripToolText(normalizeEol(readTextOr(abs, ""))).trim() : "";
}

export interface ArchiveOutcome {
  archived: string[];
  skipped: { path: string; why: string }[];
}

/**
 * Archives source files the cube was built from. A file is archived only when
 * the cube holds all of its current text word for word (coverage), unless
 * `force`: otherwise archiving could hide text the cube doesn't have.
 */
export function archiveSources(root: string, paths?: string[], opts: { force?: boolean } = {}): ArchiveOutcome {
  const sources = loadRecipe(root)?.sources.map((s) => s.path) ?? [];
  const targets = paths ?? sources;
  const homes = new Map(sourceHomes(root, targets).map((h) => [h.path, h]));
  const rulesRowId = loadCube(root).rows.find((r) => r.type === "rules")?.id ?? "Y00";
  const out: ArchiveOutcome = { archived: [], skipped: [] };
  const todo: string[] = [];
  for (const path of targets) {
    if (!sources.includes(path)) out.skipped.push({ path, why: "the cube wasn't built from it" });
    else if (isArchived(root, path)) out.skipped.push({ path, why: addedText(root, path) ? "it's already archived, and text was added to it since (see cube check)" : "it's already archived" });
    else if (!exists(absPath(root, path))) out.skipped.push({ path, why: "the file isn't there" });
    else todo.push(path);
  }
  const coverage = new Map(placedCoverage(root, todo).map((c) => [c.source, c]));
  for (const path of todo) {
    const cov = coverage.get(path);
    if (!opts.force && cov && !cov.ok) {
      out.skipped.push({ path, why: `the cube doesn't hold all of its current text word for word (${cov.problem}), so archiving it could hide text the cube doesn't have. To archive it anyway: ${TOOL_COMMAND} archive ${path} --force` });
      continue;
    }
    const abs = absPath(root, path);
    const raw = readFileSync(abs);
    const text = normalizeEol(raw.toString("utf8"));
    const own = stripToolText(text);
    const snap = archivePath(root, path);
    ensureDir(dirname(snap));
    // Byte for byte when the file holds none of the tool's own text, so a restore is exact.
    if (own === text) writeFileSync(snap, raw);
    else writeText(snap, own);
    const block = extractBlock(text);
    const holder = placeholder(path, homes.get(path), rulesRowId);
    writeText(abs, block === undefined ? holder : upsertBlock(holder, block));
    out.archived.push(path);
  }
  return out;
}

export interface RestoreOutcome {
  restored: string[];
  copied: { path: string; to: string }[];
  skipped: { path: string; why: string }[];
}

/**
 * Puts archived originals back where they were, or with `to`, copies them into
 * that folder and leaves the archive as it is. A file with text added after it
 * was archived isn't overwritten.
 */
export function restoreSources(root: string, paths: string[], opts: { to?: string; cwd?: string } = {}): RestoreOutcome {
  const out: RestoreOutcome = { restored: [], copied: [], skipped: [] };
  for (const path of paths) {
    const snap = archivePath(root, path);
    if (!exists(snap)) {
      out.skipped.push({ path, why: "it isn't in the archive" });
      continue;
    }
    const raw = readFileSync(snap);
    if (opts.to) {
      const dest = resolve(opts.cwd ?? process.cwd(), opts.to, path);
      if (exists(dest)) {
        out.skipped.push({ path, why: `${dest} already exists` });
        continue;
      }
      ensureDir(dirname(dest));
      writeFileSync(dest, raw);
      out.copied.push({ path, to: dest });
      continue;
    }
    const abs = absPath(root, path);
    const added = addedText(root, path);
    if (added) {
      const n = added.split("\n").length;
      out.skipped.push({ path, why: `text was added to it after it was archived (${n} line${n === 1 ? "" : "s"}), and putting the original back would overwrite it. Move that text into the cube or elsewhere first, or get a copy with --to <folder>` });
      continue;
    }
    const block = exists(abs) ? extractBlock(normalizeEol(readTextOr(abs, ""))) : undefined;
    ensureDir(dirname(abs));
    if (block === undefined) writeFileSync(abs, raw);
    else writeText(abs, upsertBlock(normalizeEol(raw.toString("utf8")), block));
    remove(snap);
    pruneEmptyDirs(dirname(snap), cubePaths(root).archive);
    out.restored.push(path);
  }
  return out;
}

function pruneEmptyDirs(dir: string, stopAt: string): void {
  let d = dir;
  while (d.startsWith(stopAt) && isDir(d) && readdirSync(d).length === 0) {
    rmdirSync(d);
    if (d === stopAt) break;
    d = dirname(d);
  }
}

/**
 * Finds the source a person meant: a path from where they are, a path from the
 * project root, or a file name that matches exactly one source.
 */
export function resolveSourceArg(root: string, arg: string, candidates: string[], cwd = process.cwd()): string {
  const norm = arg.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^context-cube\/\.state\/archive\//, "");
  const fromCwd = relToRoot(root, resolve(cwd, arg));
  if (candidates.includes(fromCwd)) return fromCwd;
  if (candidates.includes(norm)) return norm;
  let matches = candidates.filter((c) => c.endsWith(`/${norm}`));
  // File names are often typed in any case (and macOS doesn't mind).
  if (!matches.length) matches = candidates.filter((c) => c.toLowerCase() === norm.toLowerCase() || c.toLowerCase().endsWith(`/${norm.toLowerCase()}`));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new CubeError(`"${arg}" matches more than one file: ${matches.join(", ")}. Give its full path.`);
  throw new CubeError(`"${arg}" isn't one of them. ${candidates.length ? `They are: ${candidates.join(", ")}` : "There are none."}`);
}

/** Placeholders whose original isn't in the archive (for example, context-cube/ was moved away). */
export function orphanPlaceholders(root: string, files: string[] = listProjectFiles(root)): string[] {
  return files.filter((f) => {
    if (!/\.(md|mdx|markdown)$/i.test(f) && !isAgentFile(f)) return false;
    const abs = absPath(root, f);
    if (fileSize(abs) > 1024 * 1024 || isArchived(root, f)) return false;
    return isPlaceholder(readTextOr(abs, ""));
  });
}

export interface ArchiveIssue {
  path: string;
  kind: "added" | "missing";
  lines?: number;
}

/** For `cube check`: archived sources with text added since, and placeholders whose original is gone. */
export function archiveIssues(root: string): ArchiveIssue[] {
  const out: ArchiveIssue[] = [];
  for (const path of loadRecipe(root)?.sources.map((s) => s.path) ?? []) {
    if (isArchived(root, path)) {
      const added = addedText(root, path);
      if (added) out.push({ path, kind: "added", lines: added.split("\n").length });
    } else if (isPlaceholder(readTextOr(absPath(root, path), ""))) {
      out.push({ path, kind: "missing" });
    }
  }
  return out;
}
