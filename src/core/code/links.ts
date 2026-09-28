import { join } from "node:path";
import { readTextOr } from "../fsutil";
import { allBoxes, getRow, loadCube, type Box, type Cube } from "../cube";
import { DRAWERS } from "../format/drawers";
import { splitGenerated } from "../format/generated";
import { parseDoc } from "../format/header";
import { git, gitRoot } from "../git";
import { loadBoxState, newBoxState, saveBoxState, type BoxState } from "../state/state";
import { buildCodeIndex, declares, filesWithName, fingerprint, isPlainWord, lineWith, usesAsCode, type CodeIndex } from "./search";
import { linkStrength } from "./governs";
import { FROM_RE } from "../build/place";

/**
 * Code links (pipeline step 11, plan 8.4). For each box, find the files and
 * code names its text mentions, record them with fingerprints in the box's
 * state, and show them in a generated Z2 section. History boxes instead list
 * the commits whose message names the entry (their files are what changed).
 * No AI: reasons are the names found and where.
 */

export type { CodeFileRef, CommitRef, CodeState } from "../state/state";
import type { CodeFileRef, CommitRef } from "../state/state";

const PATH_RE = /(?:^|[\s`'"(\[])((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|swift|kt|java|py|rb|go|rs|c|cc|cpp|h|hpp|m|mm|cs|php|sql|sh|vue|svelte|dart|json|yml|yaml|toml|plist|xml))(?=$|[\s`'"),.:;\]])/g;
const BACKTICK_RE = /`([^`\n]{3,120})`/g;
const CAMEL_RE = /\b(?:[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+|[a-z]+(?:[A-Z][a-z0-9]*)+)\b/g;
const SNAKE_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/** Candidate paths and code names mentioned in a text. */
export function mentions(text: string): { paths: string[]; names: string[] } {
  const paths = new Set<string>();
  const names = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) paths.add(m[1]);
  for (const m of text.matchAll(BACKTICK_RE)) {
    const inner = m[1].trim();
    if (/\.\w{1,6}$/.test(inner) && inner.includes(".") && !inner.includes(" ")) continue; // a path, handled above
    for (const part of inner.split(/[.:()\[\]\s,<>=!&|+\-*/{}'"]+/)) {
      if (part.length >= 4 && IDENT_RE.test(part) && !/^\d/.test(part)) names.add(part);
    }
  }
  for (const m of text.matchAll(CAMEL_RE)) if (m[0].length >= 6) names.add(m[0]);
  for (const m of text.matchAll(SNAKE_RE)) if (m[0].length >= 6) names.add(m[0]);
  return { paths: [...paths], names: [...names] };
}

/** The text of a box's drawers (own text only; generated sections and markers removed). */
export function boxText(box: Box): string {
  const parts: string[] = [];
  for (const d of box.drawers) {
    if (d.z === 2) continue;
    const raw = readTextOr(d.path, "");
    const body = d.z === 0 ? `${parseDoc(raw).header?.summary ?? ""}\n${parseDoc(raw).body}` : raw;
    parts.push(splitGenerated(body).own.replace(FROM_RE, "$4"));
  }
  return parts.join("\n");
}

/** A name in more files than this is too common to link by. */
const MAX_NAME_FILES = 8;
/** A name in this many files or fewer belongs to them; in more, it's shared (a type used across the app, say). */
const OWN_FILES = 3;
const MAX_FILES = 25;

/**
 * The files a text's paths and code names point to. A name counts fully in
 * the file that defines it (`struct AppInfo`, `func verifyEcho`) or in the only
 * file that has it; elsewhere it's "used at" and counts less, so one mention of
 * a type or a platform API (`timeoutInterval`) doesn't tie a box to every file
 * that uses it. A name in more than a few files links only where it's defined,
 * and otherwise just adds weight to files linked some other way.
 */
export function linkText(idx: CodeIndex, text: string): { files: CodeFileRef[]; names: string[] } {
  const found = mentions(text);
  const why = new Map<string, string[]>();
  const add = (path: string, reason: string) => {
    const list = why.get(path) ?? [];
    if (!list.includes(reason)) list.push(reason);
    why.set(path, list);
  };
  const reason = (f: string, n: string, own: boolean) => {
    const line = lineWith(idx, f, n, { declared: own });
    // A plain word counts little anyway; a specific name defined elsewhere is marked, so it counts less here.
    if (!own && !isPlainWord(n)) return `\`${n}\` (used${line ? ` at line ${line}` : ""})`;
    return `\`${n}\`${line ? ` (line ${line})` : ""}`;
  };
  for (const p of found.paths) {
    const clean = p.replace(/^\.\//, "");
    const exact = idx.fileSet.has(clean) ? [clean] : [...idx.fileSet].filter((f) => f.endsWith(`/${clean}`));
    const matches = exact.length ? exact : idx.byBase.get(clean.split("/").pop()!) ?? [];
    if (matches.length && matches.length <= 3) for (const m of matches) add(m, "named in the text");
  }
  const names: string[] = [];
  const shared: { n: string; files: string[] }[] = [];
  for (const n of found.names) {
    let files = filesWithName(idx, n, MAX_NAME_FILES + 1);
    if (!files.length || files.length > MAX_NAME_FILES) continue;
    if (isPlainWord(n)) files = files.filter((f) => usesAsCode(idx, f, n));
    if (!files.length) continue;
    names.push(n);
    if (files.length > OWN_FILES) {
      shared.push({ n, files });
      continue;
    }
    for (const f of files) add(f, reason(f, n, files.length === 1 || declares(idx, f, n)));
  }
  for (const { n, files } of shared) {
    const home = isPlainWord(n) ? [] : files.filter((f) => declares(idx, f, n));
    for (const f of files) {
      const own = home.length <= 2 && home.includes(f);
      if (own || why.has(f)) add(f, reason(f, n, own));
    }
  }
  const files = [...why.entries()]
    .map(([path, reasons]) => ({ path, reasons, strength: linkStrength(reasons.join(", ")) }))
    .sort((a, b) => b.strength - a.strength || a.path.localeCompare(b.path))
    .slice(0, MAX_FILES)
    .map(({ path, reasons }) => ({ path, why: reasons.slice(0, 4).join(", ") + (reasons.length > 4 ? `, and ${reasons.length - 4} more` : "") }));
  return { files, names };
}

// ---------- history: commits that name the entry ----------

export function loadCommits(root: string, max = 5000): CommitRef[] {
  if (!gitRoot(root)) return [];
  const r = git(["log", "--all", "-n", String(max), "--date=short", "--format=%x1e%h%x1f%ad%x1f%s", "--name-only"], root);
  if (!r.ok) return [];
  return r.stdout
    .split("\x1e")
    .filter((b) => b.trim())
    .map((block) => {
      const [head, ...rest] = block.split("\n");
      const [hash, date, subject] = head.split("\x1f");
      return { hash, date, subject: subject ?? "", files: rest.map((l) => l.trim()).filter(Boolean) };
    });
}

export function commitsForKey(commits: CommitRef[], key: string): CommitRef[] {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  const re = new RegExp(`(?<![\\d.])${esc}(?![\\d])`);
  return commits.filter((c) => re.test(c.subject)).slice(0, 10);
}

// ---------- apply to the cube ----------

export interface LinkResult {
  boxes: number;
  withCode: number;
  historyWithCommits: number;
}

/**
 * Links every box (or the given ones) to code, and records fingerprints. With
 * `keepFingerprints`, a file that was already linked keeps the fingerprint it
 * had, so re-linking (say, after an update finds code better) doesn't hide
 * that the file changed since the box was last checked.
 */
export function linkCode(root: string, ids?: string[], opts: { keys?: Map<string, string>; keepFingerprints?: boolean } = {}): LinkResult {
  const cube = loadCube(root);
  const idx = buildCodeIndex(root);
  const commits = loadCommits(root);
  const result: LinkResult = { boxes: 0, withCode: 0, historyWithCommits: 0 };
  for (const box of allBoxes(cube)) {
    if (box.isRoot) continue;
    if (ids && !ids.includes(box.id)) continue;
    const row = getRow(cube, box.rowNum)!;
    const st = loadBoxState(root, box.id) ?? newBoxState(box.id);
    result.boxes++;
    if (row.type === "history") {
      if (st.fromGit) continue; // its commits were recorded when it was built from git
      const key = opts.keys?.get(box.id) ?? keyFromBox(box);
      const mine = key ? commitsForKey(commits, key) : [];
      st.code = { files: [], commits: mine };
      st.fingerprints = undefined;
      st.names = undefined;
      if (mine.length) result.historyWithCommits++;
      // An entry that doesn't give its own date: when the first commit naming it was made, or else
      // when its heading was added to its file. Better than the neighbor's date the build assumed.
      if (!datedByText(box, st)) {
        const date = mine.length ? mine.map((c) => c.date).filter(Boolean).sort()[0] : addedOn(root, st, box);
        if (date) {
          st.date = date;
          st.dateFrom = mine.length ? "commits" : "file";
        }
      }
    } else {
      const linked = linkText(idx, boxText(box));
      st.code = { files: linked.files };
      st.names = linked.names;
      const had = opts.keepFingerprints ? st.fingerprints ?? {} : {};
      st.fingerprints = Object.fromEntries(linked.files.map((f) => [f.path, had[f.path] ?? fingerprint(root, f.path) ?? ""]));
      if (linked.files.length) result.withCode++;
    }
    saveBoxState(root, st);
  }
  return result;
}

/** Whether a history entry's date came from its own text (older cubes: its first line holds that date). */
function datedByText(box: Box, st: BoxState): boolean {
  if (st.dateFrom) return st.dateFrom === "text";
  const first = readTextOr(join(box.dir, DRAWERS[4].file), "").split("\n").find((l) => l.trim() && !l.startsWith("<!--")) ?? "";
  return !!st.date && first.includes(st.date);
}

/**
 * When an entry's first line first appeared in the project's markdown, by git:
 * the file it came from may since be archived, and the entry may have moved
 * there from another file (a history split into an archive), so any file counts.
 */
function addedOn(root: string, st: BoxState, box: Box): string | undefined {
  const src = st.sources?.find((s) => s.drawer === 4) ?? st.sources?.[0];
  if (!src || !gitRoot(root)) return undefined;
  const first = readTextOr(join(box.dir, DRAWERS[4].file), "").split("\n").find((l) => l.trim() && !l.startsWith("<!--"));
  if (!first || first.trim().length < 8) return undefined;
  const r = git(["log", "--format=%ad", "--date=short", "-S", first, "--", "*.md", src.file], root);
  return r.ok ? r.stdout.trim().split("\n").filter(Boolean).pop() : undefined;
}

/** A history entry's key from the start of its Z4 or its source label (e.g. "1.0.8 (6)"). */
export function keyFromBox(box: Box): string | undefined {
  const src = box.header?.source ?? "";
  const title = /"(.+)"$/.exec(src)?.[1] ?? readTextOr(join(box.dir, DRAWERS[4].file), "").split("\n")[0];
  const m = /\bv?(\d+\.\d+(?:\.\d+)?(?:\s*\(\d+\))?)/.exec(title ?? "");
  return m?.[1];
}

/** The generated Z2 text for a box, from its state. */
export function z2Text(cube: Cube, box: Box, st: BoxState | undefined): string | undefined {
  if (box.isRoot) {
    const row = getRow(cube, box.rowNum)!;
    const folders = new Map<string, number>();
    for (const b of row.boxes) {
      for (const f of loadBoxState(cube.root, b.id)?.code?.files ?? []) {
        const parts = f.path.split("/");
        const dir = parts.length > 1 ? `${parts.slice(0, Math.min(parts.length - 1, 3)).join("/")}/` : "(project root)";
        folders.set(dir, (folders.get(dir) ?? 0) + 1);
      }
    }
    if (!folders.size) return undefined;
    const top = [...folders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    return ["Main folders for this row (from its boxes' code links):", ...top.map(([d, n]) => `- \`${d}\` (${n} link${n === 1 ? "" : "s"})`)].join("\n");
  }
  const code = st?.code;
  if (!code) return undefined;
  if (code.commits?.length) {
    return [
      "Commits for this entry (from git, by the version in their message):",
      ...code.commits.map((c) => `- ${c.hash} ${c.date} ${c.subject.slice(0, 120)}${c.files.length ? ` (${c.files.length} file${c.files.length === 1 ? "" : "s"}: ${c.files.slice(0, 12).map((f) => `\`${f}\``).join(", ")}${c.files.length > 12 ? ", …" : ""})` : ""}`),
    ].join("\n");
  }
  if (!code.files.length) return undefined;
  return ["Code this box mentions (found by code search):", ...code.files.map((f) => `- \`${f.path}\`: ${f.why}`)].join("\n");
}
