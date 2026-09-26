import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextOr, writeText } from "./fsutil";
import { joinGenerated, splitGenerated } from "./format/generated";
import { splitFrontmatter } from "./format/header";
import { git } from "./git";

/**
 * Merging cube files (plan 11). Generated files never block a merge: git keeps
 * one side and the post-merge hook regenerates them. Drawer files merge their
 * own text normally and drop the generated sections (regenerated after the
 * merge). Per-box state keeps the side updated most recently.
 */

export type MergeKind = "generated" | "drawer" | "state";

/** A merge driver: writes the result to `ours` and returns git's exit code (0 = merged). */
export function mergeFile(kind: MergeKind, base: string, ours: string, theirs: string): number {
  if (kind === "generated") return 0; // keep ours; `cube index` rewrites it after the merge
  if (kind === "state") {
    const parse = (p: string) => {
      try {
        return JSON.parse(readTextOr(p, "")) as { updated?: string };
      } catch {
        return undefined;
      }
    };
    const a = parse(ours);
    const b = parse(theirs);
    if (!a && b) writeText(ours, readTextOr(theirs, ""));
    else if (a && b && (b.updated ?? "") > (a.updated ?? "")) writeText(ours, readTextOr(theirs, ""));
    return 0;
  }
  // Drawer: merge the header (Z0) and own text; generated sections are rebuilt later.
  const own = (p: string) => {
    const text = readTextOr(p, "");
    const { yaml, body } = splitFrontmatter(text);
    const rest = splitGenerated(body).own;
    return yaml === undefined ? rest : `---\n${yaml}\n---\n${rest}`;
  };
  const gen = splitGenerated(splitFrontmatter(readTextOr(ours, "")).body).generated;
  const dir = mkdtempSync(join(tmpdir(), "cube-merge-"));
  try {
    const [o, a, b] = ["base", "ours", "theirs"].map((n) => join(dir, n));
    writeFileSync(o, own(base));
    writeFileSync(a, own(ours));
    writeFileSync(b, own(theirs));
    const r = spawnSync("git", ["merge-file", "-p", "-L", "ours", "-L", "base", "-L", "theirs", a, o, b], { encoding: "utf8" });
    const merged = r.stdout ?? "";
    writeText(ours, joinGenerated(merged, gen));
    return r.status === 0 ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const DRIVERS: Record<MergeKind, string> = {
  generated: "node context-cube/.tool/cube.mjs merge-file generated %O %A %B",
  drawer: "node context-cube/.tool/cube.mjs merge-file drawer %O %A %B",
  state: "node context-cube/.tool/cube.mjs merge-file state %O %A %B",
};

/** Registers the merge drivers in this clone's git config (drivers can't be committed). */
export function installMergeDrivers(root: string): void {
  for (const [kind, cmd] of Object.entries(DRIVERS)) {
    git(["config", `merge.cube-${kind}.name`, `Context Cube ${kind} files`], root);
    git(["config", `merge.cube-${kind}.driver`, cmd], root);
  }
}

export function removeMergeDrivers(root: string): void {
  for (const kind of Object.keys(DRIVERS)) git(["config", "--remove-section", `merge.cube-${kind}`], root);
}

export const GITATTRIBUTES = [
  "# Append-only files: keep both sides' lines when branches merge.",
  ".state/retired.txt merge=union",
  ".state/aliases.txt merge=union",
  ".state/approvals.log merge=union",
  "# Generated files never block a merge: the tool rebuilds them afterwards.",
  "CUBE.md merge=cube-generated linguist-generated=true",
  "**/ROW.md merge=cube-generated linguist-generated=true",
  "**/ROW-p*.md merge=cube-generated linguist-generated=true",
  "# Drawers merge their own text; generated sections are rebuilt. Box state keeps the newer side.",
  "Y*/X*/Z*.md merge=cube-drawer",
  ".state/boxes/*.json merge=cube-state",
  ".tool/cube.mjs linguist-generated=true -diff",
  "",
].join("\n");
