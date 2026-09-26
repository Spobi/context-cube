import { createHash } from "node:crypto";
import { join } from "node:path";
import { appendLine, exists, readJsonOr, readTextOr, remove, writeJson, writeText } from "../fsutil";
import { cubePaths } from "../paths";
import { parseId, idKey } from "../format/ids";

export function sha(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ---------- retired numbers ----------

export interface Retired {
  id: string;
  date: string;
  reason: string;
}

/** Numbers used and deleted; never reused (plan 3.1). One tab-separated line each. */
export function loadRetired(root: string): Retired[] {
  const text = readTextOr(cubePaths(root).retired, "");
  const out: Retired[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [id, date = "", ...reason] = line.split("\t");
    if (parseId(id)) out.push({ id, date, reason: reason.join("\t") });
  }
  return out;
}

export function retire(root: string, id: string, reason: string, now = new Date()): void {
  const p = cubePaths(root).retired;
  if (!exists(p)) writeText(p, "# Numbers used and deleted. Never reused. id<TAB>date<TAB>reason\n");
  appendLine(p, `${id}\t${now.toISOString().slice(0, 10)}\t${reason.replace(/[\t\n]/g, " ")}`);
}

// ---------- aliases ----------

export interface Alias {
  alias: string;
  target: string;
}

/** Legacy references and old coordinates → current coordinates. One tab-separated line each. */
export function loadAliases(root: string): Alias[] {
  const text = readTextOr(cubePaths(root).aliases, "");
  const out: Alias[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const idx = line.lastIndexOf("\t");
    if (idx <= 0) continue;
    out.push({ alias: line.slice(0, idx), target: line.slice(idx + 1).trim() });
  }
  return out;
}

export function addAliases(root: string, aliases: Alias[]): void {
  if (!aliases.length) return;
  const p = cubePaths(root).aliases;
  const existing = new Set(loadAliases(root).map((a) => `${a.alias}\t${a.target}`));
  if (!exists(p)) writeText(p, "# Legacy references and old coordinates → current coordinates. alias<TAB>target\n");
  for (const a of aliases) {
    const line = `${a.alias.replace(/[\t\n]/g, " ")}\t${a.target}`;
    if (existing.has(line)) continue;
    existing.add(line);
    appendLine(p, line);
  }
}

/** Follows alias chains (old → moved → moved again) to the current target. */
export function resolveAlias(aliases: Alias[], ref: string): string | undefined {
  const map = new Map<string, string>();
  for (const a of aliases) map.set(normalizeAlias(a.alias), a.target);
  let cur = map.get(normalizeAlias(ref));
  const seen = new Set<string>();
  while (cur && map.has(normalizeAlias(cur)) && !seen.has(cur)) {
    seen.add(cur);
    cur = map.get(normalizeAlias(cur));
  }
  return cur;
}

export function normalizeAlias(s: string): string {
  const key = idKey(s);
  if (key) {
    const c = parseId(s)!;
    return `id:${key}${c.drawer !== undefined ? `.${c.drawer}` : ""}`;
  }
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

// ---------- per-box state ----------

export interface CodeFileRef {
  path: string;
  why: string;
}

export interface CommitRef {
  hash: string;
  date: string;
  subject: string;
  files: string[];
}

export interface CodeState {
  files: CodeFileRef[];
  commits?: CommitRef[];
}

export interface BoxState {
  id: string;
  created: string;
  updated: string;
  /** Checksum and size of each drawer's own text (generated sections excluded). */
  drawers: Record<string, { sha: string; chars: number }>;
  /** Fingerprints of code files listed in Z2, when the box was last updated. */
  fingerprints?: Record<string, string>;
  /** Code names this box mentions that were found in the code at last check. */
  names?: string[];
  /** When the knowledge in this box dates from (YYYY-MM-DD), for "reach" stats. */
  date?: string;
  /** History entries built from git commits (their Z2 is the commits, not a key lookup). */
  fromGit?: boolean;
  /** History entries: the key (e.g. a build number) this entry is for. */
  historyKey?: string;
  /** Code this box mentions (or, for history, the commits that name it). */
  code?: CodeState;
  /** Checksums of the generated sections the tool last wrote, per drawer. */
  generated?: Record<string, string>;
  /** Checksum of the approved Z1 text (invariants rows). */
  approvedZ1?: string;
  /** Where migrated text came from, for the coverage proof. */
  sources?: { file: string; start: number; end: number; drawer: number; wrapped?: boolean }[];
}

export function boxStatePath(root: string, id: string): string {
  return join(cubePaths(root).boxesState, `${id}.json`);
}

export function loadBoxState(root: string, id: string): BoxState | undefined {
  return readJsonOr<BoxState | undefined>(boxStatePath(root, id), undefined);
}

export function saveBoxState(root: string, state: BoxState): void {
  writeJson(boxStatePath(root, state.id), state);
}

export function removeBoxState(root: string, id: string): void {
  remove(boxStatePath(root, id));
}

export function newBoxState(id: string, now = new Date()): BoxState {
  const t = now.toISOString();
  return { id, created: t, updated: t, drawers: {} };
}
