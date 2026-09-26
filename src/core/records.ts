import { cpSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLine, ensureDir, exists, readJsonOr, readTextOr, writeJson, writeText } from "./fsutil";
import { allBoxes, drawerPath, getBox, getRow, loadCube, type Box, type Cube } from "./cube";
import { DRAWERS } from "./format/drawers";
import { joinGenerated, splitGenerated } from "./format/generated";
import { drawerOwnText, markedPieces, pieceText } from "./build/coverage";
import { splitLines } from "./build/markdown";
import { isArchived, readSource } from "./build/sources";
import { loadBoxState, recordIntact, recordMark, saveBoxState, type BoxState, type RecordMark } from "./state/state";
import { CubeError, deleteBox, touchState, updateZ0, writeDrawer } from "./ops";
import { cubePaths, CUBE_DIR, relToRoot, TOOL_COMMAND } from "./paths";
import { gitRoot, gitUser } from "./git";

/**
 * Records (plan 2.4): text moved word for word from the project's original
 * files, and closed history entries. They are the evidence the cube exists to
 * keep, including old details a rewrite would drop ("we tried this; it failed
 * because…"). Agents add to a record, dated, below the original; they never
 * rewrite it. A person can replace or delete one on purpose: that goes in the
 * approvals log, and the text it takes out is kept in the archive.
 *
 * Each record drawer has a mark in its box's state (`records`): the checksum
 * and length of the text kept as the record. The drawer must still start with
 * that text, and dated notes follow it. The mark moves with the box, and only
 * `cube replace` changes it, so adding a note can't acknowledge an earlier
 * rewrite. Invariant text (Z1 in an invariants row) has its own approval flow
 * and isn't handled here.
 */

type Sources = NonNullable<BoxState["sources"]>;

export interface DrawerRecord {
  box: Box;
  z: number;
  /** Where its migrated text came from (empty for a history entry written after setup). */
  sources: Sources;
  /** A closed history entry's Z4. */
  history: boolean;
  /** Unset only until the next index marks it. */
  mark?: RecordMark;
}

/** The record a drawer holds, if it holds one. */
export function drawerRecord(root: string, cube: Cube, box: Box, z: number, st: BoxState | undefined = loadBoxState(root, box.id)): DrawerRecord | undefined {
  if (z === 2 || (z === 1 && getRow(cube, box.rowNum)?.type === "invariants")) return undefined;
  const sources = (st?.sources ?? []).filter((s) => s.drawer === z);
  const history = getRow(cube, box.rowNum)?.type === "history" && !box.isRoot && z === 4 && box.header?.status !== "open";
  const mark = st?.records?.[`Z${z}`];
  // What makes a drawer a record, until the next index gives it its mark (an entry closed a moment ago, or a cube from 0.2.0).
  const unmarked = sources.length > 0 || (history && box.drawers.some((d) => d.z === z));
  return mark || unmarked ? { box, z, sources, history, mark } : undefined;
}

/** Whether a box holds any record (invariants have their own delete flow, `propose delete`). */
export function isRecordBox(root: string, cube: Cube, box: Box): boolean {
  if (box.isRoot || getRow(cube, box.rowNum)?.type === "invariants") return false;
  const st = loadBoxState(root, box.id);
  return DRAWERS.some((d) => drawerRecord(root, cube, box, d.z, st));
}

/**
 * Gives each record drawer without a mark its mark, from its text now. Runs on
 * every index, so migrated text gets its mark when the build places it and a
 * history entry when it closes. Cubes from 0.2.0 kept a checksum of the whole
 * drawer for a record a person replaced: that checksum carries over, so a change
 * made since is still reported.
 */
export function markRecords(root: string, cube: Cube = loadCube(root), now = new Date()): number {
  let marked = 0;
  for (const box of allBoxes(cube)) {
    const st = loadBoxState(root, box.id);
    if (!st) continue;
    let dirty = false;
    for (const d of box.drawers) {
      const key = `Z${d.z}`;
      const old = st.replaced?.[key];
      const rec = drawerRecord(root, cube, box, d.z, st);
      if (rec?.mark || (!rec && !old)) continue;
      const own = drawerOwnText(d.path, d.z);
      st.records = { ...(st.records ?? {}), [key]: old ? { sha: old.sha, chars: own.length, at: old.at, replaced: true } : recordMark(own, now.toISOString()) };
      marked++;
      dirty = true;
    }
    if (st.replaced) {
      delete st.replaced;
      dirty = true;
    }
    if (dirty) saveBoxState(root, st);
  }
  return marked;
}

/**
 * Drops marks that don't fit a box's text. For boxes a merge gave the same
 * number: they shared one state file, so it can't say which mark is whose. The
 * next index marks each one again from its own text.
 */
export function dropForeignMarks(root: string, id: string): void {
  const box = getBox(loadCube(root), id);
  const st = loadBoxState(root, id);
  if (!box || !st?.records) return;
  for (const [key, mark] of Object.entries(st.records)) {
    const path = drawerPath(box, Number(key.slice(1)));
    if (!exists(path) || !recordIntact(drawerOwnText(path, Number(key.slice(1))), mark)) delete st.records[key];
  }
  saveBoxState(root, st);
}

function describeSources(sources: Sources): string {
  const [s] = sources;
  if (sources.length === 1) return `${s.file} (${s.start === s.end ? `line ${s.start}` : `lines ${s.start}–${s.end}`})`;
  const files = [...new Set(sources.map((s) => s.file))];
  return `${files.join(", ")} (${sources.length} pieces)`;
}

/** What a record is, in a phrase: "Y05.X004.Z4 holds text moved word for word from DESIGN.md (lines 10–40)". */
export function describeRecord(rec: DrawerRecord): string {
  const what = `${rec.box.id}.Z${rec.z}`;
  if (rec.sources.length) return `${what} holds text moved word for word from ${describeSources(rec.sources)}${rec.history ? ", in a closed history entry" : ""}`;
  if (rec.history) return `${what} is a closed history entry, a record of the past`;
  return `${what} is a record: text kept as it was written`;
}

/** Why a record can't be rewritten, and what to do instead. */
export function recordRefusal(rec: DrawerRecord): string {
  const id = rec.box.id;
  const lines = [`${describeRecord(rec)}. Records aren't rewritten, so the cube keeps what was actually written, old details included.`];
  if (!exists(drawerPath(rec.box, rec.z))) lines.push(`- Its file is gone. ${TOOL_COMMAND} check says where the text can come back from.`);
  if (rec.z !== 0) lines.push(`- To add what changed (dated, below the original): ${TOOL_COMMAND} write ${id} Z${rec.z} --append @<file>`);
  else lines.push(`- To change its summary or read-when line: ${TOOL_COMMAND} edit ${id} --summary "..." --read-when "..."`);
  lines.push(`- If the person asked for this text itself to change: ${TOOL_COMMAND} replace ${id} Z${rec.z} @<file> --reason "<why>" (a person confirms it)`);
  return lines.join("\n");
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Adds text below a drawer's own text, under a dated label. Nothing that was
 * there changes, and neither does a record's mark: it still covers the text
 * above the note. Returns a warning when that text had already been changed
 * outside the tool (adding doesn't acknowledge it).
 */
export function appendToDrawer(root: string, id: string, z: number, text: string, now = new Date()): string | undefined {
  if (z === 0) throw new CubeError("Z0 can't be added to this way.");
  const box = getBox(loadCube(root), id);
  if (!box) throw new CubeError(`No box ${id}.`);
  const add = text.replace(/\s+$/, "");
  if (!add.trim()) throw new CubeError("There's nothing to add.");
  const path = drawerPath(box, z);
  const { own, generated } = splitGenerated(readTextOr(path, ""));
  const sep = own === "" || own.endsWith("\n\n") ? "" : own.endsWith("\n") ? "\n" : "\n\n";
  writeText(path, joinGenerated(`${own}${sep}**Added ${localDate(now)}:**\n${add}\n`, generated));
  touchState(root, box.id, box.dir);
  const issue = recordIssues(root, undefined, [box.id]).find((i) => i.z === z);
  return issue ? `${box.id}.Z${z} had been changed outside the tool before this note, and it still counts as changed until a person records or undoes that (see ${TOOL_COMMAND} check).` : undefined;
}

function logRecordDecision(root: string, entry: Record<string, unknown>): void {
  appendLine(cubePaths(root).approvals, JSON.stringify({ t: new Date().toISOString(), ...entry, by: gitUser(root) ?? process.env.USER ?? "someone", reviewedByPerson: true }));
}

// ---------- kept copies: what a person's replace or delete takes out ----------

function stamp(d: Date): string {
  // 2026-09-26T151203: sortable, safe in file names.
  return d.toISOString().slice(0, 19).replace(/:/g, "");
}

function unusedPath(base: string, ext = ""): string {
  let p = `${base}${ext}`;
  for (let i = 2; exists(p); i++) p = `${base}-${i}${ext}`;
  return p;
}

/** Keeps a drawer's text before a person replaces it. Returns where, from the project root. */
function keepReplaced(root: string, box: Box, z: number, text: string, now: Date): string {
  const path = unusedPath(join(cubePaths(root).keptRecords, "replaced", box.id, `Z${z}-${stamp(now)}`), ".md");
  writeText(path, text);
  return relToRoot(root, path);
}

/** Keeps a box's folder, and its bookkeeping as box-state.json, before it's deleted. Returns where, from the project root. */
export function keepDeletedBox(root: string, box: Box): string {
  const dest = unusedPath(join(cubePaths(root).keptRecords, "deleted", `${box.id}-${box.name}`));
  ensureDir(dirname(dest));
  cpSync(box.dir, dest, { recursive: true });
  const st = loadBoxState(root, box.id);
  if (st) writeJson(join(dest, "box-state.json"), st);
  return relToRoot(root, dest);
}

/**
 * A person replaces a record's text on purpose (`text`), or, with no text,
 * records the drawer's current text as a change they made on purpose (for
 * example, an edit in their own editor that `cube check` flagged). Replaced
 * text is kept in the archive first.
 */
export function replaceRecord(root: string, id: string, z: number, text: string | undefined, reason: string, now = new Date()): { rec: DrawerRecord; kept?: string } {
  if (!reason.trim()) throw new CubeError('Say why with --reason "...": it goes in the approvals log.');
  const cube = loadCube(root);
  const box = getBox(cube, id);
  if (!box) throw new CubeError(`No box ${id}.`);
  if (z === 2) throw new CubeError(`Z2 is written by code search. Re-link it with: ${TOOL_COMMAND} links ${box.id}`);
  if (z === 1 && getRow(cube, box.rowNum)?.type === "invariants") {
    throw new CubeError(`Invariant text changes through approval: ${TOOL_COMMAND} propose edit ${box.id} --text @<file> --reason "<why>"`);
  }
  const rec = drawerRecord(root, cube, box, z);
  if (!rec) throw new CubeError(`${box.id}.Z${z} isn't a record (text moved from the original files, or a closed history entry). Change it with: ${TOOL_COMMAND} write ${box.id} Z${z} @<file>`);
  const path = drawerPath(box, z);
  if (text === undefined && !exists(path)) {
    throw new CubeError(`${box.id}.Z${z}'s file is gone, so there's no text to record. Put it back (${TOOL_COMMAND} check says how), give the text: ${TOOL_COMMAND} replace ${box.id} Z${z} @<file> --reason "<why>", or remove the whole box: ${TOOL_COMMAND} delete ${box.id} --reason "<why>"`);
  }
  let kept: string | undefined;
  if (text !== undefined) {
    const body = text.endsWith("\n") ? text : `${text}\n`;
    if (!body.trim()) throw new CubeError(`Replacing a record with nothing would remove it. To remove the whole box, a person runs: ${TOOL_COMMAND} delete ${box.id} --reason "<why>"`);
    const before = exists(path) ? drawerOwnText(path, z) : "";
    if (before.trim()) kept = keepReplaced(root, box, z, before, now);
    if (z === 0) updateZ0(root, box.id, (h) => ({ header: h, body }));
    else writeDrawer(root, box.id, z, body);
  }
  const fresh = getBox(loadCube(root), box.id)!;
  const st = touchState(root, fresh.id, fresh.dir);
  st.records = { ...(st.records ?? {}), [`Z${z}`]: recordMark(drawerOwnText(drawerPath(fresh, z), z), now.toISOString(), true) };
  saveBoxState(root, st);
  logRecordDecision(root, { kind: "replace-record", box: box.id, drawer: `Z${z}`, sources: rec.sources.map((s) => `${s.file} L${s.start}-L${s.end}`), reason, ...(kept ? { kept } : {}) });
  return { rec, kept };
}

/** A person deletes a box that holds a record. Its folder is kept in the archive first. */
export function deleteRecordBox(root: string, id: string, reason: string): { id: string; kept: string } {
  if (!reason.trim()) throw new CubeError('Say why with --reason "...": it goes in the approvals log.');
  const box = getBox(loadCube(root), id);
  if (!box) throw new CubeError(`No box ${id}.`);
  const st = loadBoxState(root, box.id);
  const kept = keepDeletedBox(root, box);
  const gone = deleteBox(root, box.id, `record deleted by a person: ${reason}`);
  logRecordDecision(root, { kind: "delete-record", box: gone, sources: (st?.sources ?? []).map((s) => `${s.file} L${s.start}-L${s.end}`), reason, kept });
  return { id: gone, kept };
}

// ---------- the check: records still hold their text ----------

export interface RecordIssue {
  id: string;
  /** changed: the kept text isn't there word for word; missing: the drawer's file is gone; removed: the box's folder is gone. */
  kind: "changed" | "missing" | "removed";
  z?: number;
  sources: Sources;
  replacedAt?: string;
  /** The drawer's file, from the project root. */
  path?: string;
  /** Where the earlier text can come from: archived originals, and git. */
  archived: boolean;
  git: boolean;
}

/**
 * Records whose kept text is no longer at the start of their drawer (unless a
 * person replaced it: `cube replace` moves the mark), record drawers whose file
 * is gone, and boxes that held a record but whose folder is gone without
 * `cube delete`. Migrated pieces from archived sources are also compared with
 * the archive, the one copy of the original nobody edits. Invariant Z1 is left
 * to the approval check. `ids` limits it to those boxes.
 */
export function recordIssues(root: string, cube: Cube = loadCube(root), ids?: string[]): RecordIssue[] {
  const dir = cubePaths(root).boxesState;
  if (!exists(dir)) return [];
  const git = !!gitRoot(root);
  const byId = new Map(allBoxes(cube).map((b) => [b.id, b]));
  const sourceLines = new Map<string, string[]>();
  const original = (file: string, start: number, end: number): string => {
    if (!sourceLines.has(file)) sourceLines.set(file, splitLines(readSource(root, file)));
    return `${sourceLines.get(file)!.slice(start - 1, end).join("\n")}\n`;
  };
  const out: RecordIssue[] = [];
  const files = ids ? ids.map((id) => `${id}.json`) : readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  for (const f of files) {
    const st = readJsonOr<BoxState | undefined>(join(dir, f), undefined);
    if (!st) continue;
    const marks = st.records ?? {};
    const archived = (st.sources ?? []).filter((s) => isArchived(root, s.file));
    if (!Object.keys(marks).length && !archived.length) continue;
    const box = byId.get(st.id);
    if (!box) {
      out.push({ id: st.id, kind: "removed", sources: st.sources ?? [], archived: archived.length > 0, git });
      continue;
    }
    const invariants = getRow(cube, box.rowNum)?.type === "invariants";
    const drawers = [...new Set([...Object.keys(marks).map((k) => Number(k.slice(1))), ...archived.map((s) => s.drawer)])].sort();
    for (const z of drawers) {
      if (invariants && z === 1) continue;
      const mark = marks[`Z${z}`];
      const sources = (st.sources ?? []).filter((s) => s.drawer === z);
      const pieces = archived.filter((s) => s.drawer === z);
      const issue = { id: box.id, z, sources, path: `${CUBE_DIR}/${box.relDir}/${DRAWERS[z].file}`, archived: pieces.length > 0, git };
      const file = drawerPath(box, z);
      if (!exists(file)) {
        out.push({ ...issue, kind: "missing" });
        continue;
      }
      const own = drawerOwnText(file, z);
      if (mark && !recordIntact(own, mark)) {
        out.push({ ...issue, kind: "changed", replacedAt: mark.replaced ? mark.at : undefined });
        continue;
      }
      // A person's replacement is the record now; the original stays in the archive.
      if (mark?.replaced || !pieces.length) continue;
      const marked = markedPieces(own);
      const changed = pieces.some((s) => {
        const want = original(s.file, s.start, s.end);
        return pieceText(own, marked, s, sources.length, want) !== want;
      });
      if (changed) out.push({ ...issue, kind: "changed" });
    }
  }
  return out;
}

/** Where the earlier text can come back from, truthfully: "<lead>: <ways>." or that there's no other copy. */
function putBack(i: RecordIssue, lead: string): string {
  const ways: string[] = [];
  if (i.archived) ways.push(`a person can get the original from the archive with ${TOOL_COMMAND} restore ${[...new Set(i.sources.map((s) => s.file))].join(" ")} --to <folder>`);
  if (i.git) ways.push(i.kind === "removed" ? `git has it if it was committed (git log --diff-filter=D --stat -- ${CUBE_DIR}/ lists deleted files)` : `git has it if it was committed (git log -p -- ${i.path})`);
  return ways.length ? `${lead}: ${ways.join(", or ")}.` : "There's no other copy of the earlier text: the project isn't in git, and the text wasn't archived.";
}

export function renderRecordIssue(i: RecordIssue): { message: string; fix: string } {
  const from = i.sources.length ? describeSources(i.sources) : undefined;
  if (i.kind === "removed") {
    return {
      message: `${i.id} held ${from ? `text moved word for word from ${from}` : "a record (a closed history entry, or text kept as written)"}, but its folder is gone and it wasn't deleted with cube delete.`,
      fix: `${putBack(i, "To get it back")} If a person meant to remove it, they delete context-cube/.state/boxes/${i.id}.json too.`,
    };
  }
  if (i.kind === "missing") {
    return {
      message: `${i.id}.Z${i.z} holds a record${from ? ` (text moved word for word from ${from})` : ""}, but its file is gone.`,
      fix: `${putBack(i, "To get it back")} If a person meant to remove it, they delete the whole box: ${TOOL_COMMAND} delete ${i.id} --reason "<why>"`,
    };
  }
  const since = i.replacedAt ? ` (a person replaced it on ${i.replacedAt.slice(0, 10)}, and it has changed since)` : "";
  const add = i.z === 0 ? "" : ` Then add what changed with: ${TOOL_COMMAND} write ${i.id} Z${i.z} --append @<file>`;
  return {
    message: from
      ? `${i.id}.Z${i.z} no longer holds ${from} word for word${since}.${i.archived ? " The original is in the archive." : ""}`
      : `${i.id}.Z${i.z} no longer holds its recorded text word for word${since}.`,
    fix: `If a person changed it on purpose, record that: ${TOOL_COMMAND} replace ${i.id} Z${i.z} --reason "<why>". ${putBack(i, "Otherwise put the text back")}${i.archived || i.git ? add : ""}`,
  };
}
