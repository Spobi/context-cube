import { join } from "node:path";
import { statSync } from "node:fs";
import { getBox, loadCube, type Box, type Cube } from "../cube";
import type { CubeConfig } from "../config";
import type { EditPiece } from "../../adapters/types";
import { appendLine, readTextOr } from "../fsutil";
import { absPath } from "../scan";
import { CUBE_DIR, cubePaths, TOOL_COMMAND } from "../paths";
import { loadBoxState } from "../state/state";
import { estimateTokens } from "../tokens";
import { governingByFile, type Governing } from "./governs";
import { namesNear, narrow, type Hunk } from "./changes";
import { globToRegExp } from "./pathRules";

/**
 * Invariants read before an edit. A path rule names the invariants that
 * govern a file when the agent opens it, but a central file loads a dozen at
 * once and nothing stopped an edit before any of them was opened: on Quickie,
 * four call-engine files were changed with 19 rules loaded and none opened.
 * So the guard checks at the edit itself. The invariants whose code the edit
 * is near (all that govern the file, where the person asks for that) must have
 * been opened this session, since the context was last compacted, or the
 * edit is held back with a list of what to read. One invariant holds edits
 * back at most twice a session; after that the edit goes ahead and counts as
 * a miss in `cube stats`, so a read the hooks didn't see can't stop the work.
 */

/** How many times one invariant may hold back edits in a session (since the last compaction). */
export const MAX_HOLDS = 2;

export function invariantPath(inv: Box): string {
  return `${CUBE_DIR}/${inv.relDir}/Z1-invariants.md`;
}

// ---------- which invariants an edit needs ----------

/** Why an edit needs its invariants: it's near their code, it changes the file as a whole (or where it can't be placed), or the person asked for all of them here. */
export type ReadFirstReason = "near" | "whole" | "all";

/**
 * The invariants to have open before these changes to a file (relative to
 * the project root), or undefined when the check is off for it. "Near" is
 * what makes a box stale (changes.ts): a changed line or the lines around it
 * show one of the invariant's code names, or the change is inside a
 * declaration of one. An invariant with none of its names in the file (one
 * that names only the file) counts for any change.
 */
export function invariantsForEdit(
  cube: Cube,
  config: CubeConfig,
  rel: string,
  pieces: EditPiece[],
  governs: Map<string, Governing[]> = governingByFile(cube),
): { list: Governing[]; why: ReadFirstReason } | undefined {
  const { readFirst, readAllFor } = config.invariants;
  const all = readAllFor.some((g) => globToRegExp(g.replace(/^\.\//, "")).test(rel));
  if (readFirst === "off" && !all) return undefined;
  const governing = governs.get(rel) ?? [];
  if (all || readFirst === "all") return { list: governing, why: "all" };
  if (!governing.length) return { list: [], why: "near" };
  const text = readTextOr(absPath(cube.root, rel), "");
  const hunks: Hunk[] = [];
  for (const p of pieces) {
    const h = p.old ? hunksFor(text, p.old, p.new ?? "", !!p.all) : undefined;
    if (!h) return { list: governing, why: "whole" };
    hunks.push(...h);
  }
  const list = governing.filter((g) => {
    const mine = narrow(hunks, text, namesOf(cube, g));
    return !mine || namesNear(hunks, text, mine).length > 0;
  });
  return { list, why: "near" };
}

/** The code names that tie an invariant to its files: its own, or those of the boxes it borrowed them from. */
function namesOf(cube: Cube, g: Governing): string[] {
  if (g.own || !g.via.length) return loadBoxState(cube.root, g.inv.id)?.names ?? [];
  const names = new Set<string>();
  for (const id of g.via) {
    const box = getBox(cube, id);
    for (const n of (box && loadBoxState(cube.root, box.id)?.names) ?? []) names.add(n);
  }
  return [...names];
}

/**
 * Where replacing `old` with `neu` changes a file, as the hunks `git diff`
 * would show: the lines that differ (lines both sides share left out), with
 * three lines around them. Undefined when `old` isn't in the file.
 */
export function hunksFor(text: string, old: string, neu: string, every = false): Hunk[] | undefined {
  const lines = text.split("\n");
  const out: Hunk[] = [];
  let i = text.indexOf(old);
  if (i < 0) return undefined;
  for (; i >= 0; i = every ? text.indexOf(old, i + old.length) : -1) {
    // Whole lines: from the start of the first line `old` touches to the end of its last.
    const start = text.lastIndexOf("\n", i - 1) + 1;
    let end = old.endsWith("\n") ? i + old.length - 1 : text.indexOf("\n", i + old.length);
    if (end < 0) end = text.length;
    const oldLines = text.slice(start, end).split("\n");
    let replaced = text.slice(start, i) + neu + text.slice(i + old.length, Math.max(end, i + old.length));
    if (old.endsWith("\n") && replaced.endsWith("\n")) replaced = replaced.slice(0, -1);
    const newLines = replaced.split("\n");
    let p = 0;
    while (p < oldLines.length && p < newLines.length && oldLines[p] === newLines[p]) p++;
    let s = 0;
    while (s < oldLines.length - p && s < newLines.length - p && oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]) s++;
    // 0-based: the first line that differs, and the line after the last.
    const first = text.slice(0, start).split("\n").length - 1 + p;
    const after = first + oldLines.length - p - s;
    const changed = [
      ...oldLines.slice(p, oldLines.length - s).map((t, k) => ({ at: first + k + 1, text: t })),
      ...newLines.slice(p, newLines.length - s).map((t, k) => ({ at: first + k + 1, text: t })),
    ];
    if (!changed.length) continue;
    out.push({ lines: [...lines.slice(Math.max(0, first - 3), first), ...changed.map((c) => c.text), ...lines.slice(after, after + 3)], changed });
  }
  return out;
}

// ---------- what the session has opened: an append-only log ----------

/**
 * Hooks for reads run side by side (an agent opens several files at once), so
 * the check keeps its own lines, appended one call at a time, not a file that
 * is read, changed, and written back: `<time> seen`, `open <Z1 path>`,
 * `compact`, `check <file>`, `hold <ids>`, `miss <file> <ids>`.
 */
export interface ReadFirstLog {
  /** The guard's after-tool hook ran this session, so it sees what the agent reads. */
  seen: boolean;
  /** Invariant texts opened since the context was last compacted. */
  opened: Set<string>;
  /** How often each invariant held back an edit since then. */
  holds: Map<string, number>;
  /** The check looked at an edit of a file invariants govern. */
  checked: boolean;
  /** Edits it let through with invariants unread. */
  misses: { t: string; file: string; invariants: string[] }[];
}

function logPath(root: string, session: string): string {
  return join(cubePaths(root).logs, "sessions", `${session.replace(/[^\w-]/g, "_")}.read-first`);
}

function append(root: string, session: string, lines: string[]): void {
  if (!lines.length) return;
  const t = new Date().toISOString();
  appendLine(logPath(root, session), lines.map((l) => `${t} ${l}`).join("\n"));
}

export function loadReadFirst(root: string, session: string): ReadFirstLog {
  const log: ReadFirstLog = { seen: false, opened: new Set(), holds: new Map(), checked: false, misses: [] };
  for (const line of readTextOr(logPath(root, session), "").split("\n")) {
    const [t, verb, ...rest] = line.split(" ");
    if (verb === "seen") log.seen = true;
    else if (verb === "open") log.opened.add(rest.join(" "));
    else if (verb === "check") log.checked = true;
    else if (verb === "hold") for (const id of rest[0]?.split(",") ?? []) log.holds.set(id, (log.holds.get(id) ?? 0) + 1);
    else if (verb === "miss") log.misses.push({ t, file: rest.slice(0, -1).join(" "), invariants: rest.at(-1)!.split(",") });
    else if (verb === "compact") {
      log.opened.clear();
      log.holds.clear();
    }
  }
  return log;
}

/** Files the agent read (relative to the project root); only invariant texts are kept. */
export function noteReads(root: string, session: string, rels: string[]): void {
  const lines = rels.filter((r) => /^context-cube\/.+\/Z1-invariants\.md$/.test(r)).map((r) => `open ${r}`);
  if (!/ seen$/m.test(readTextOr(logPath(root, session), ""))) lines.unshift("seen");
  append(root, session, lines);
}

/** The agent's context was compacted: what it opened before is no longer in front of it. */
export function noteCompact(root: string, session: string): void {
  append(root, session, ["compact"]);
}

// ---------- the check ----------

/**
 * Checks an edit: the text that holds it back, or undefined to let it go
 * ahead. `pieces` are relative to the project root. Nothing is checked until
 * the guard's after-tool hook has run this session (hooks installed before
 * the check existed don't report reads, and every edit would be held).
 */
export function checkEdit(root: string, session: string, config: CubeConfig, pieces: EditPiece[]): string | undefined {
  if (config.invariants.readFirst === "off" && !config.invariants.readAllFor.length) return undefined;
  const log = loadReadFirst(root, session);
  if (!log.seen) return undefined;
  const byFile = new Map<string, EditPiece[]>();
  for (const p of pieces) {
    if (p.file.startsWith("/") || p.file.startsWith(`${CUBE_DIR}/`)) continue;
    byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
  }
  if (!byFile.size) return undefined;
  const cube = loadCube(root);
  const governs = governingByFile(cube);
  const lines: string[] = [];
  const held: { rel: string; list: Governing[]; why: ReadFirstReason }[] = [];
  const misses: string[] = [];
  for (const [rel, ps] of byFile) {
    if (!governs.has(rel)) continue;
    const need = invariantsForEdit(cube, config, rel, ps, governs);
    if (!need) continue;
    lines.push(`check ${rel}`);
    const unread = need.list.filter((g) => !log.opened.has(invariantPath(g.inv)));
    if (!unread.length) continue;
    if (unread.some((g) => (log.holds.get(g.inv.id) ?? 0) < MAX_HOLDS)) held.push({ rel, list: unread, why: need.why });
    else misses.push(`miss ${rel} ${unread.map((g) => g.inv.id).join(",")}`);
  }
  if (held.length) {
    lines.push(`hold ${[...new Set(held.flatMap((h) => h.list.map((g) => g.inv.id)))].join(",")}`);
    append(root, session, lines);
    return holdText(cube, config, held);
  }
  append(root, session, [...lines, ...misses]);
  return undefined;
}

function holdText(cube: Cube, config: CubeConfig, held: { rel: string; list: Governing[]; why: ReadFirstReason }[]): string {
  const out: string[] = [];
  const paths = new Set<string>();
  for (const { rel, list, why } of held) {
    out.push(
      why === "all" ? `Context Cube: before editing ${rel}, read every invariant that governs it (this project asks for that here). Rules that must never be broken:`
      : why === "whole" ? `Context Cube: this edit changes ${rel} as a whole, so read every invariant that governs it first. Rules that must never be broken:`
      : `Context Cube: this edit to ${rel} is near code that invariants govern. Read them first; they are rules that must never be broken:`,
    );
    for (const g of list) {
      out.push(`- ${g.inv.id}: ${g.inv.header?.summary ?? ""} → ${invariantPath(g.inv)}`);
      paths.add(invariantPath(g.inv));
    }
  }
  let chars = 0;
  for (const p of paths) {
    try {
      chars += statSync(absPath(cube.root, p)).size;
    } catch {
      // gone: counts as nothing
    }
  }
  const n = paths.size;
  out.push(
    `Open ${n === 1 ? "it" : `these ${n} files (all at once is fine)`}, about ${estimateTokens(chars, config.tokens.charsPerToken).toLocaleString("en-US")} tokens, then make the edit again. If the change needs an invariant to change, propose that (${TOOL_COMMAND} propose edit <id> …) instead of editing around it.`,
  );
  return out.join("\n");
}
