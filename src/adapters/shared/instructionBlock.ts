import { join } from "node:path";
import { exists, readTextOr, remove, writeText } from "../../core/fsutil";
import { blockSeparator, hasBlock, removeBlock, upsertBlock } from "../../core/index/block";
import { emptyManifest, loadManifest, saveManifest, deleteManifest } from "../../core/installs";

/**
 * Writes the always-loaded block into an agent instruction file at the project
 * root (CLAUDE.md, AGENTS.md). Records the separator it added and whether it
 * created the file, so removing the block restores the file exactly.
 */
export function writeInstructionBlock(root: string, adapter: string, fileName: string, block: string): void {
  const path = join(root, fileName);
  const existed = exists(path);
  const text = readTextOr(path, "");
  const manifest = loadManifest(root, adapter, "shared") ?? emptyManifest(adapter, "shared");
  if (!manifest.block || !hasBlock(text)) {
    manifest.block = { file: fileName, sep: blockSeparator(text), created: manifest.block?.created ?? !existed };
  }
  writeText(path, upsertBlock(text, block));
  saveManifest(root, manifest);
}

export function removeInstructionBlock(root: string, adapter: string): void {
  const manifest = loadManifest(root, adapter, "shared");
  const fileName = manifest?.block?.file;
  if (!manifest || !fileName) return;
  const path = join(root, fileName);
  if (exists(path)) {
    const next = removeBlock(readTextOr(path, ""), manifest.block!.sep);
    if (next === "" && manifest.block!.created) remove(path);
    else writeText(path, next);
  }
  delete manifest.block;
  if (!manifest.features.length && !manifest.files.length && !manifest.settings) deleteManifest(root, adapter, "shared");
  else saveManifest(root, manifest);
}
