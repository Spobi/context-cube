import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, exists, isDir, readTextOr, remove, writeText } from "./fsutil";
import { getBox, loadCube, readDrawer, type Box, type Cube, type Row } from "./cube";
import { bulkUpdateHeaders, createBox, CubeError, oneLine, touchState } from "./ops";
import { addAliases, loadBoxState, saveBoxState } from "./state/state";
import { gitUser } from "./git";
import { slugify } from "./format/names";
import { splitGenerated } from "./format/generated";
import type { Link } from "./format/header";

/**
 * Open history entries and fragments (plan 8.3). One entry is open at a time.
 * Each update adds a separate fragment file, named by time and person, so two
 * people never edit the same file. The open entry's Z4 is generated from its
 * fragments; closing the entry combines them permanently and writes Z0.
 */

export function historyRow(cube: Cube): Row {
  const row = cube.rows.find((r) => r.type === "history");
  if (!row) throw new CubeError("This cube has no history row.");
  return row;
}

export function openEntry(cube: Cube): Box | undefined {
  const row = historyRow(cube);
  return [...row.boxes].reverse().find((b) => b.header?.status === "open");
}

export function fragmentsDir(box: Box): string {
  return join(box.dir, "fragments");
}

export function listFragments(box: Box): { file: string; text: string }[] {
  const dir = fragmentsDir(box);
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ file: f, text: readTextOr(join(dir, f), "") }));
}

/** The generated Z4 of an open entry: its fragments in time order. */
export function fragmentsText(box: Box): string | undefined {
  const frags = listFragments(box);
  if (!frags.length) return undefined;
  return [`Fragments so far (combined when the entry closes):`, "", ...frags.map((f) => `### ${f.file.replace(/\.md$/, "")}\n${f.text.replace(/\n+$/, "")}`)].join("\n\n");
}

function person(root: string, by?: string): string {
  const who = by ?? gitUser(root) ?? process.env.USER ?? "someone";
  return slugify(who, 3);
}

function stamp(d = new Date()): string {
  // 2026-09-24T1512, sortable, safe in file names.
  return d.toISOString().slice(0, 16).replace(":", "");
}

export interface OpenOptions {
  key?: string;
  name?: string;
  summary?: string;
}

export function openNew(root: string, opts: OpenOptions = {}): Box {
  const cube = loadCube(root);
  const row = historyRow(cube);
  if (openEntry(cube)) throw new CubeError(`${openEntry(cube)!.id} is already open. Close it first: cube history close`);
  const today = new Date().toISOString().slice(0, 10);
  const label = opts.key ?? today;
  const box = createBox(root, row.num, {
    name: opts.name ?? slugify(opts.key ? `${label}` : `work ${label}`),
    summary: opts.summary ?? `Work in progress${opts.key ? ` on ${opts.key}` : ""} (open entry; the summary is written when it closes).`,
    readWhen: "Checking what has changed since the last closed entry.",
    status: "open",
    writtenBy: "person",
  });
  const st = loadBoxState(root, box.id)!;
  st.historyKey = opts.key;
  saveBoxState(root, st);
  if (opts.key) addAliases(root, [{ alias: opts.key, target: box.id }]);
  return box;
}

export interface AddOptions {
  key?: string;
  by?: string;
  touches?: Link[];
  now?: Date;
}

/**
 * Adds a fragment to the open entry. With a key (e.g. a build number) that
 * differs from the open entry's, the open entry is closed first and a new one
 * opened: "a new build number closes the entry and opens the next".
 */
export function addFragment(root: string, text: string, opts: AddOptions = {}): { box: Box; file: string; closed?: string } {
  if (!text.trim()) throw new CubeError("The fragment is empty.");
  let cube = loadCube(root);
  let open = openEntry(cube);
  let closed: string | undefined;
  if (open && opts.key) {
    const cur = loadBoxState(root, open.id)?.historyKey;
    if (cur && cur.replace(/\s+/g, "") !== opts.key.replace(/\s+/g, "")) {
      closed = closeEntry(root, {}).id;
      open = undefined;
    } else if (!cur) {
      const st = loadBoxState(root, open.id)!;
      st.historyKey = opts.key;
      saveBoxState(root, st);
      addAliases(root, [{ alias: opts.key, target: open.id }]);
    }
  }
  if (!open) open = openNew(root, { key: opts.key });
  cube = loadCube(root);
  const box = getBox(cube, open.id)!;
  const dir = fragmentsDir(box);
  ensureDir(dir);
  let file = `${stamp(opts.now)}-${person(root, opts.by)}.md`;
  for (let i = 2; exists(join(dir, file)); i++) file = `${stamp(opts.now)}-${person(root, opts.by)}-${i}.md`;
  writeText(join(dir, file), text.endsWith("\n") ? text : `${text}\n`);
  if (opts.touches?.length) bulkUpdateHeaders(root, new Map([[box.id, { addLinks: opts.touches }]]));
  return { box, file, closed };
}

export interface CloseOptions {
  summary?: string;
  readWhen?: string;
  name?: string;
}

/** Closes the open entry: fragments become its Z4 for good, and Z0 gets its summary. */
export function closeEntry(root: string, opts: CloseOptions): Box {
  const cube = loadCube(root);
  const open = openEntry(cube);
  if (!open) throw new CubeError("No history entry is open.");
  const frags = listFragments(open);
  const existing = splitGenerated(readDrawer(open, 4) ?? "").own;
  const combined = existing + frags.map((f) => f.text.replace(/\n*$/, "\n")).join("\n");
  const z4 = join(open.dir, "Z4-detail.md");
  if (combined.trim()) writeText(z4, combined);
  else remove(z4);
  remove(fragmentsDir(open));
  const first = frags[0]?.text.replace(/\s+/g, " ").trim() ?? "";
  const summary = opts.summary ?? (first ? firstSentence(first) : open.header?.summary ?? "Closed entry.");
  const key = loadBoxState(root, open.id)?.historyKey;
  bulkUpdateHeaders(
    root,
    new Map([
      [
        open.id,
        {
          status: "ok",
          summary,
          readWhen: opts.readWhen ?? `Debugging or changing anything this entry touched${key ? ` (${key})` : ""}.`,
          name: opts.name,
          writtenBy: opts.summary ? "person" : "migrated",
        },
      ],
    ]),
  );
  touchState(root, open.id, getBox(loadCube(root), open.id)!.dir);
  return getBox(loadCube(root), open.id)!;
}

function firstSentence(s: string): string {
  const m = /^(.{20,200}?[.!?])(\s|$)/.exec(s);
  return oneLine(m ? m[1] : s.slice(0, 200));
}
