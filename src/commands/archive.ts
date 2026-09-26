import { findProjectRoot, TOOL_COMMAND } from "../core/paths";
import { CubeError } from "../core/ops";
import { loadRecipe } from "../core/build/recipe";
import { isArchived, listArchived } from "../core/build/sources";
import { isAgentFile } from "../core/logs/memoryFiles";
import { archiveSources, resolveSourceArg, restoreSources } from "../core/archive";

/** `cube archive [files...]`: moves originals the cube was built from into its archive. */
export function archiveCmd(files: string[], opts: { cwd?: string; force?: boolean }): string[] {
  const root = findProjectRoot(opts.cwd);
  const sources = loadRecipe(root)?.sources.map((s) => s.path) ?? [];
  if (!sources.length) throw new CubeError("This cube wasn't built from existing files, so there's nothing to archive.");
  const targets = files.length ? files.map((f) => resolveSourceArg(root, f, sources, opts.cwd)) : sources.filter((p) => !isArchived(root, p));
  if (!targets.length) return ["Every file the cube was built from is already archived."];
  const r = archiveSources(root, targets, { force: opts.force });
  const out: string[] = [];
  if (r.archived.length) {
    out.push(`Archived ${r.archived.length} file${r.archived.length === 1 ? "" : "s"}:`, ...r.archived.map((p) => `  ${p}`));
    out.push("Each original is kept, unchanged, in context-cube/.state/archive/, and a short placeholder took its place.", `Put one back with: ${TOOL_COMMAND} restore <file>`);
  }
  for (const s of r.skipped) out.push(`Left ${s.path} in place: ${s.why}.`);
  return out;
}

/** `cube restore [files...]`: puts archived originals back, or copies them somewhere with --to. */
export function restoreCmd(files: string[], opts: { cwd?: string; all?: boolean; to?: string }): string[] {
  const root = findProjectRoot(opts.cwd);
  const archived = listArchived(root);
  if (!archived.length) return ["Nothing is archived."];
  if (!files.length && !opts.all) throw new CubeError(`Name the files to put back, or use --all. Archived: ${archived.join(", ")}`);
  const targets = opts.all ? archived : files.map((f) => resolveSourceArg(root, f, archived, opts.cwd));
  const r = restoreSources(root, targets, { to: opts.to, cwd: opts.cwd });
  const out: string[] = [];
  if (r.copied.length) out.push(`Copied ${r.copied.length} original${r.copied.length === 1 ? "" : "s"} (the archive is unchanged):`, ...r.copied.map((c) => `  ${c.path} → ${c.to}`));
  if (r.restored.length) {
    out.push(`Put back ${r.restored.length} file${r.restored.length === 1 ? "" : "s"}:`, ...r.restored.map((p) => `  ${p}`));
    out.push("Their content is still in the cube too, so your agent may now read both.");
    if (r.restored.some(isAgentFile)) out.push("A restored agent file's rules also load from the cube's block, so they'll be read twice each session.");
    out.push(`To archive them again: ${TOOL_COMMAND} archive <file>`);
  }
  for (const s of r.skipped) out.push(`Skipped ${s.path}: ${s.why}.`);
  return out;
}
