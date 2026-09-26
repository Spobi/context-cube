import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextOr, writeJson, writeText } from "./fsutil";
import { joinGenerated, splitGenerated } from "./format/generated";
import { splitFrontmatter } from "./format/header";
import { git } from "./git";

/**
 * Merging cube files (plan 11). Generated files never block a merge: git keeps
 * one side and the post-merge hook regenerates them. Drawer files merge their
 * own text normally and drop the generated sections (regenerated after the
 * merge); text a side only added at the end (a dated note, usually) is kept
 * after the other side's, even where git would call it a conflict. Per-box state merges field by field: what only one
 * side changed is kept, and where both changed the same field, the side updated
 * most recently wins. A record's mark is taken whole from one side.
 */

export type MergeKind = "generated" | "drawer" | "state";

/** A merge driver: writes the result to `ours` and returns git's exit code (0 = merged). */
export function mergeFile(kind: MergeKind, base: string, ours: string, theirs: string): number {
  if (kind === "generated") return 0; // keep ours; `cube index` rewrites it after the merge
  if (kind === "state") {
    const parse = (p: string) => {
      try {
        return JSON.parse(readTextOr(p, "")) as Json & { updated?: string };
      } catch {
        return undefined;
      }
    };
    const o = parse(base);
    const a = parse(ours);
    const b = parse(theirs);
    if (!a && b) writeText(ours, readTextOr(theirs, ""));
    else if (a && b) writeJson(ours, mergeJson(o, a, b, (b.updated ?? "") > (a.updated ?? "")));
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
  const [ob, oa, ot] = [own(base), own(ours), own(theirs)];
  const merged = mergeAdditions(ob, oa, ot);
  if (merged !== undefined) {
    writeText(ours, joinGenerated(merged, gen));
    return 0;
  }
  const dir = mkdtempSync(join(tmpdir(), "cube-merge-"));
  try {
    const [o, a, b] = ["base", "ours", "theirs"].map((n) => join(dir, n));
    writeFileSync(o, ob);
    writeFileSync(a, oa);
    writeFileSync(b, ot);
    const r = spawnSync("git", ["merge-file", "-p", "-L", "ours", "-L", "base", "-L", "theirs", a, o, b], { encoding: "utf8" });
    const merged = r.stdout ?? "";
    writeText(ours, joinGenerated(merged, gen));
    return r.status === 0 ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * When a side only added text after the base (a dated note, usually), its
 * addition goes after the other side's text: after ours, then theirs, when both
 * only added. git merge-file calls two additions at the end a conflict, and an
 * addition next to the other side's edit too; for notes below a record, keeping
 * both is the answer. Anything else is left to git (undefined).
 */
export function mergeAdditions(base: string, ours: string, theirs: string): string | undefined {
  if (ours === base || theirs === base) return undefined;
  const added = (side: string) => (side.startsWith(base) ? side.slice(base.length) : undefined);
  const [a, t] = [added(ours), added(theirs)];
  if (a === undefined && t === undefined) return undefined;
  // One side already has the other's addition (the same note twice, or one merged before).
  if (a !== undefined && t !== undefined && t.startsWith(a)) return theirs;
  if (a !== undefined && t !== undefined && a.startsWith(t)) return ours;
  const [text, addition] = t !== undefined ? [ours, t] : [theirs, a!];
  // An addition that started a new paragraph stays one.
  const gap = base.endsWith("\n\n") && !text.endsWith("\n\n") ? "\n" : "";
  return `${text}${gap}${addition}`;
}

type Json = { [key: string]: unknown };

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

/** Fields whose entries merge whole: a record's mark is one checksum of one text, so its parts never mix across sides. */
const WHOLE_ENTRIES = new Set(["records"]);

/**
 * Three-way merge of two JSON objects: a field only one side changed keeps that
 * change (so one person's approval checksum survives another's later link
 * refresh); where both changed it, nested objects merge the same way and
 * anything else takes the newer side. With `whole`, the fields' values are
 * taken whole instead of merged.
 */
export function mergeJson(base: unknown, ours: Json, theirs: Json, theirsNewer: boolean, whole = false): Json {
  const b = isObject(base) ? base : {};
  const out: Json = {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const [o, a, t] = [b[key], ours[key], theirs[key]];
    let v: unknown;
    if (same(a, t)) v = a;
    else if (same(o, a)) v = t;
    else if (same(o, t)) v = a;
    else if (!whole && isObject(a) && isObject(t)) v = mergeJson(o, a, t, theirsNewer, WHOLE_ENTRIES.has(key));
    else v = theirsNewer ? t : a;
    if (v !== undefined) out[key] = v;
  }
  return out;
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
  "# Drawers merge their own text; generated sections are rebuilt. Box state merges field by field.",
  "Y*/X*/Z*.md merge=cube-drawer",
  ".state/boxes/*.json merge=cube-state",
  ".tool/cube.mjs linguist-generated=true -diff",
  "",
].join("\n");
