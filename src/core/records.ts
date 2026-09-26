import { readdirSync } from "node:fs";
import { join } from "node:path";
import { appendLine, exists, readJsonOr, readTextOr, writeText } from "./fsutil";
import { allBoxes, drawerPath, getBox, getRow, loadCube, type Box, type Cube } from "./cube";
import { DRAWERS } from "./format/drawers";
import { joinGenerated, splitGenerated } from "./format/generated";
import { FROM_RE, wrapPiece } from "./build/place";
import { drawerOwnText } from "./build/coverage";
import { splitLines } from "./build/markdown";
import { isArchived, readSource } from "./build/sources";
import { loadBoxState, saveBoxState, sha, type BoxState } from "./state/state";
import { CubeError, deleteBox, touchState, updateZ0, writeDrawer } from "./ops";
import { cubePaths, CUBE_DIR, TOOL_COMMAND } from "./paths";
import { gitUser } from "./git";

/**
 * Records (plan 2.4): text moved word for word from the project's original
 * files, and closed history entries. They are the evidence the cube exists to
 * keep, including old details a rewrite would drop ("we tried this; it failed
 * because…"). Agents add to a record, dated, below the original; they never
 * rewrite it. A person can replace or delete one on purpose, and that goes in
 * the approvals log. Invariant text (Z1 in an invariants row) has its own
 * approval flow and isn't handled here.
 */

type Sources = NonNullable<BoxState["sources"]>;

export interface DrawerRecord {
  box: Box;
  z: number;
  /** Where its migrated text came from (empty for a history entry written after setup). */
  sources: Sources;
  history: boolean;
}

/** The record a drawer holds, if it holds one. */
export function drawerRecord(root: string, cube: Cube, box: Box, z: number, st: BoxState | undefined = loadBoxState(root, box.id)): DrawerRecord | undefined {
  const row = getRow(cube, box.rowNum);
  if (row?.type === "invariants" && z === 1) return undefined;
  const sources = (st?.sources ?? []).filter((s) => s.drawer === z);
  const history = row?.type === "history" && !box.isRoot && z === 4 && box.header?.status !== "open" && box.drawers.some((d) => d.z === 4);
  return sources.length || history ? { box, z, sources, history } : undefined;
}

/** Whether a box holds any record (invariants have their own delete flow, `propose delete`). */
export function isRecordBox(root: string, cube: Cube, box: Box): boolean {
  if (box.isRoot || getRow(cube, box.rowNum)?.type === "invariants") return false;
  const st = loadBoxState(root, box.id);
  return DRAWERS.some((d) => drawerRecord(root, cube, box, d.z, st));
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
  return `${what} is a closed history entry, a record of the past`;
}

/** Why a record can't be rewritten, and what to do instead. */
export function recordRefusal(rec: DrawerRecord): string {
  const id = rec.box.id;
  const lines = [`${describeRecord(rec)}. Records aren't rewritten, so the cube keeps what was actually written, old details included.`];
  if (rec.z !== 0) lines.push(`- To add what changed (dated, below the original): ${TOOL_COMMAND} write ${id} Z${rec.z} --append @<file>`);
  else lines.push(`- To change its summary or read-when line: ${TOOL_COMMAND} edit ${id} --summary "..." --read-when "..."`);
  lines.push(`- If the person asked for this text itself to change: ${TOOL_COMMAND} replace ${id} Z${rec.z} @<file> --reason "<why>" (a person confirms it)`);
  return lines.join("\n");
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Adds text below a drawer's own text, under a dated label. Migrated text
 * stored bare is wrapped in cube:from markers first, so the coverage proof
 * still finds it word for word.
 */
export function appendToDrawer(root: string, id: string, z: number, text: string, now = new Date()): void {
  if (z === 0) throw new CubeError("Z0 can't be added to this way.");
  const box = getBox(loadCube(root), id);
  if (!box) throw new CubeError(`No box ${id}.`);
  const add = text.replace(/\s+$/, "");
  if (!add.trim()) throw new CubeError("There's nothing to add.");
  const path = drawerPath(box, z);
  const { own, generated } = splitGenerated(readTextOr(path, ""));
  const st = loadBoxState(root, box.id);
  const mine = (st?.sources ?? []).filter((s) => s.drawer === z);
  let base = own;
  // Text a person replaced isn't the original any more, so it isn't marked as coming from it.
  const replaced = !!st?.replaced?.[`Z${z}`];
  const bare = !replaced && mine.length === 1 && !mine[0].wrapped && !own.match(FROM_RE) ? mine[0] : undefined;
  if (bare) base = wrapPiece({ source: bare.file, start: bare.start, end: bare.end, text: own.endsWith("\n") ? own : `${own}\n` });
  const sep = base === "" || base.endsWith("\n\n") ? "" : base.endsWith("\n") ? "\n" : "\n\n";
  const next = `${base}${sep}**Added ${localDate(now)}:**\n${add}\n`;
  writeText(path, joinGenerated(next, generated));
  const fresh = touchState(root, box.id, box.dir);
  if (bare) fresh.sources = (fresh.sources ?? []).map((s) => (s.drawer === z && s.file === bare.file && s.start === bare.start ? { ...s, wrapped: true } : s));
  // A replaced record stays acknowledged: appending changes nothing that was there.
  const rep = fresh.replaced?.[`Z${z}`];
  if (rep) fresh.replaced![`Z${z}`] = { ...rep, sha: sha(next) };
  saveBoxState(root, fresh);
}

function logRecordDecision(root: string, entry: Record<string, unknown>): void {
  appendLine(cubePaths(root).approvals, JSON.stringify({ t: new Date().toISOString(), ...entry, by: gitUser(root) ?? process.env.USER ?? "someone", reviewedByPerson: true }));
}

/**
 * A person replaces a record's text on purpose (`text`), or, with no text,
 * records the drawer's current text as a change they made on purpose (for
 * example, an edit in their own editor that `cube check` flagged).
 */
export function replaceRecord(root: string, id: string, z: number, text: string | undefined, reason: string, now = new Date()): DrawerRecord {
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
  if (text !== undefined) {
    const body = text.endsWith("\n") ? text : `${text}\n`;
    if (!body.trim()) throw new CubeError(`Replacing a record with nothing would remove it. To remove the whole box, a person runs: ${TOOL_COMMAND} delete ${box.id} --reason "<why>"`);
    if (z === 0) updateZ0(root, box.id, (h) => ({ header: h, body }));
    else writeDrawer(root, box.id, z, body);
  }
  const fresh = getBox(loadCube(root), box.id)!;
  const st = touchState(root, fresh.id, fresh.dir);
  st.replaced = { ...(st.replaced ?? {}), [`Z${z}`]: { at: now.toISOString(), sha: sha(drawerOwnText(drawerPath(fresh, z), z)) } };
  saveBoxState(root, st);
  logRecordDecision(root, { kind: "replace-record", box: box.id, drawer: `Z${z}`, sources: rec.sources.map((s) => `${s.file} L${s.start}-L${s.end}`), reason });
  return rec;
}

/** A person deletes a box that holds a record. */
export function deleteRecordBox(root: string, id: string, reason: string): string {
  if (!reason.trim()) throw new CubeError('Say why with --reason "...": it goes in the approvals log.');
  const st = loadBoxState(root, id);
  const gone = deleteBox(root, id, `record deleted by a person: ${reason}`);
  logRecordDecision(root, { kind: "delete-record", box: gone, sources: (st?.sources ?? []).map((s) => `${s.file} L${s.start}-L${s.end}`), reason });
  return gone;
}

// ---------- the check: records still hold their original text ----------

export interface RecordIssue {
  id: string;
  kind: "changed" | "removed";
  z?: number;
  sources: Sources;
  replacedAt?: string;
  path?: string;
}

/**
 * Migrated pieces whose text no longer matches the archived original, unless a
 * person replaced them on purpose, and boxes that held migrated text but whose
 * folder is gone without `cube delete`. Only archived sources are compared: the
 * archive is the one copy of the original nobody edits. Invariant Z1 is left to
 * the approval check.
 */
export function recordIssues(root: string, cube: Cube = loadCube(root)): RecordIssue[] {
  const dir = cubePaths(root).boxesState;
  if (!exists(dir)) return [];
  const byId = new Map(allBoxes(cube).map((b) => [b.id, b]));
  const sourceLines = new Map<string, string[]>();
  const original = (file: string, start: number, end: number): string => {
    if (!sourceLines.has(file)) sourceLines.set(file, splitLines(readSource(root, file)));
    return `${sourceLines.get(file)!.slice(start - 1, end).join("\n")}\n`;
  };
  const out: RecordIssue[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const st = readJsonOr<BoxState | undefined>(join(dir, f), undefined);
    const archived = (st?.sources ?? []).filter((s) => isArchived(root, s.file));
    if (!st || !archived.length) continue;
    const box = byId.get(st.id);
    if (!box) {
      out.push({ id: st.id, kind: "removed", sources: archived });
      continue;
    }
    const invariants = getRow(cube, box.rowNum)?.type === "invariants";
    for (const z of [...new Set(archived.map((s) => s.drawer))].sort()) {
      if (invariants && z === 1) continue;
      const path = drawerPath(box, z);
      const own = drawerOwnText(path, z);
      const rep = st.replaced?.[`Z${z}`];
      if (rep && sha(own) === rep.sha) continue;
      const all = (st.sources ?? []).filter((s) => s.drawer === z);
      const wrapped = new Map([...own.matchAll(FROM_RE)].map((m) => [`${m[1]}|${m[2]}|${m[3]}`, m[4]]));
      const pieces = archived.filter((s) => s.drawer === z);
      const changed = pieces.some((s) => {
        const text = wrapped.get(`${s.file}|${s.start}|${s.end}`) ?? (all.length === 1 && !s.wrapped ? own : undefined);
        return text !== original(s.file, s.start, s.end);
      });
      if (changed) out.push({ id: box.id, kind: "changed", z, sources: pieces, replacedAt: rep?.at, path: `${CUBE_DIR}/${box.relDir}/${DRAWERS[z].file}` });
    }
  }
  return out;
}

export function renderRecordIssue(i: RecordIssue): { message: string; fix: string } {
  const from = describeSources(i.sources);
  if (i.kind === "removed") {
    return {
      message: `${i.id} held text moved word for word from ${from}, but its folder is gone and it wasn't deleted with cube delete.`,
      fix: `Get it back from git history. If a person meant to remove it, they delete context-cube/.state/boxes/${i.id}.json too.`,
    };
  }
  const since = i.replacedAt ? ` (a person replaced it on ${i.replacedAt.slice(0, 10)}, and it has changed since)` : "";
  const add = i.z === 0 ? "" : `, then add what changed with: ${TOOL_COMMAND} write ${i.id} Z${i.z} --append @<file>`;
  return {
    message: `${i.id}.Z${i.z} no longer holds ${from} word for word${since}. The original is in the archive.`,
    fix: `If a person changed it on purpose, record that: ${TOOL_COMMAND} replace ${i.id} Z${i.z} --reason "<why>". Otherwise put the text back from git (git log -p -- ${i.path})${add}.`,
  };
}
