import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeEol } from "../fsutil";
import { absPath, fileSize, isBinary, isMarkdown, listProjectFiles } from "../scan";

/**
 * Code search for linking boxes to code (plan 6.11, 8.4). No AI. Reads the
 * project's code files once and answers "which files contain this name?".
 * Plain in-memory search keeps it dependency-free and identical on every
 * machine; a mid-size app (tens of thousands of lines) takes well under a second.
 */

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|swift|kt|kts|java|py|rb|go|rs|c|cc|cpp|h|hpp|m|mm|cs|php|scala|sql|sh|vue|svelte|dart|ex|exs|lua|json|yml|yaml|toml|plist|xml|gradle)$/i;

export interface CodeIndex {
  files: string[];
  fileSet: Set<string>;
  byBase: Map<string, string[]>;
  /** Each file's code: comments and URLs blanked out, strings kept, lines where they were. */
  text: Map<string, string>;
  /** Each file as written, comments included. */
  raw: Map<string, string>;
  /** The code with string contents blanked too, made when first asked for. */
  bare: Map<string, string>;
}

/**
 * Coding agents' own settings (hooks, permissions, rule files): configuration
 * for the agent, not the project's code. A box about camera permissions isn't
 * about .claude/settings.json's "permissions".
 */
const AGENT_CONFIG_RE = /(^|\/)\.(claude|codex|agents|cursor|windsurf)\//;

export function isAgentConfig(path: string): boolean {
  return AGENT_CONFIG_RE.test(path);
}

export function isCodeFile(path: string): boolean {
  return CODE_EXT.test(path) && !isMarkdown(path) && !isAgentConfig(path);
}

export function buildCodeIndex(root: string, files: string[] = listProjectFiles(root)): CodeIndex {
  const idx: CodeIndex = { files: [], fileSet: new Set(files), byBase: new Map(), text: new Map(), raw: new Map(), bare: new Map() };
  for (const f of files) {
    const base = f.split("/").pop()!;
    idx.byBase.set(base, [...(idx.byBase.get(base) ?? []), f]);
    if (!isCodeFile(f)) continue;
    const abs = absPath(root, f);
    if (fileSize(abs) > 2_000_000 || isBinary(abs)) continue;
    try {
      const raw = normalizeEol(readFileSync(abs, "utf8"));
      idx.raw.set(f, raw);
      idx.text.set(f, codeOnly(raw, f));
      idx.files.push(f);
    } catch {
      // unreadable; skip
    }
  }
  return idx;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SLASH = /\.(ts|tsx|js|jsx|mjs|cjs|swift|kt|kts|java|go|rs|c|cc|cpp|h|hpp|m|mm|cs|php|scala|dart|gradle|vue|svelte)$/i;
const HASH = /\.(py|rb|sh|yml|yaml|toml|ex|exs|php)$/i;
const DASH = /\.(sql|lua)$/i;
const ANGLE = /\.(xml|plist|vue|svelte)$/i;
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)\]]*/gi;
/** Import lines say what a file depends on, not what it does: `import CallKit` isn't a use of CallKit. */
const IMPORT_RE = /^[ \t]*(?:@?import\b|#import\b|#include\b|using\s+[\w.]+\s*;|from\s+[\w.]+\s+import\b).*$/gm;

/**
 * A code file with its comments, URLs, and import lines (and, with
 * `strings: "blank"`, the contents of its strings) replaced by spaces, keeping
 * every line where it was. So a word in a comment ("out-of-band",
 * "head-of-line") or a URL ("apps.apple.com") doesn't count as the code using
 * that name.
 */
export function codeOnly(text: string, path: string, opts: { strings?: "keep" | "blank" } = {}): string {
  const slash = SLASH.test(path);
  const hash = HASH.test(path);
  const dash = DASH.test(path);
  const angle = ANGLE.test(path);
  const blankStrings = opts.strings === "blank";
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    let end = -1;
    if ((slash && c === "/" && next === "/") || (hash && c === "#") || (dash && c === "-" && next === "-")) {
      end = text.indexOf("\n", i);
      if (end < 0) end = n;
    } else if ((slash || dash) && c === "/" && next === "*") {
      end = text.indexOf("*/", i + 2);
      end = end < 0 ? n : end + 2;
    } else if (angle && text.startsWith("<!--", i)) {
      end = text.indexOf("-->", i + 4);
      end = end < 0 ? n : end + 3;
    }
    if (end >= 0) {
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || (c === "`" && slash)) {
      // Quotes and apostrophes end at the line's end (except template strings), so a stray one can't hide much.
      let j = i + 1;
      while (j < n && text[j] !== c && (c === "`" || text[j] !== "\n")) j += text[j] === "\\" ? 2 : 1;
      if (blankStrings) blank(i + 1, Math.min(j, n));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out
    .join("")
    .replace(URL_RE, (u) => " ".repeat(u.length))
    .replace(IMPORT_RE, (l) => " ".repeat(l.length));
}

function bareText(idx: CodeIndex, file: string): string {
  let t = idx.bare.get(file);
  if (t === undefined) {
    t = codeOnly(idx.raw.get(file) ?? "", file, { strings: "blank" });
    idx.bare.set(file, t);
  }
  return t;
}

/** One plain word ("band", "Calling"): likely prose, so it counts only where the code clearly uses it. */
export function isPlainWord(name: string): boolean {
  return /^(?:[a-z]+|[A-Z][a-z]+)$/.test(name);
}

export const DECLARE = "(?:func|case|let|var|class|struct|enum|protocol|extension|typealias|actor|def|function|const|type|interface|val|fun|fn|module|table|column|property|static|export)";

/**
 * Whether a file clearly uses `name` as code: declares it, calls or labels it,
 * reaches it as a member (`.subscribed`), or has it as a whole quoted string
 * ("qlim"). Words inside strings and comments don't count.
 */
export function usesAsCode(idx: CodeIndex, file: string, name: string): boolean {
  const n = escape(name);
  if (new RegExp(`\\b${DECLARE}\\s+${n}\\b|[.]${n}\\b|\\b${n}\\s*[(:]`).test(bareText(idx, file))) return true;
  return new RegExp(`["'\`]${n}["'\`]`).test(idx.text.get(file) ?? "");
}

/** Whether a file declares `name` (`struct AppInfo`, `func verifyEcho`, `const peerCaps`). */
export function declares(idx: CodeIndex, file: string, name: string): boolean {
  return new RegExp(`\\b${DECLARE}\\s+${escape(name)}\\b`).test(bareText(idx, file));
}

/**
 * Code files where `name` appears as a whole word, outside comments and URLs.
 * With `raw`, comments count too (to tell whether a name still exists at all).
 */
export function filesWithName(idx: CodeIndex, name: string, limit = 50, opts: { raw?: boolean } = {}): string[] {
  const re = new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`);
  const out: string[] = [];
  for (const f of idx.files) {
    if (re.test((opts.raw ? idx.raw : idx.text).get(f)!)) {
      out.push(f);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** The first line in `file` where `name` appears (or, with `declared`, where it's declared), for a one-line reason. */
export function lineWith(idx: CodeIndex, file: string, name: string, opts: { declared?: boolean } = {}): number | undefined {
  const text = idx.text.get(file);
  if (!text) return undefined;
  const lines = text.split("\n");
  if (opts.declared) {
    const decl = new RegExp(`\\b${DECLARE}\\s+${escape(name)}\\b`);
    const i = bareText(idx, file).split("\n").findIndex((l) => decl.test(l));
    if (i >= 0) return i + 1;
  }
  const re = new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`);
  const i = lines.findIndex((l) => re.test(l));
  return i >= 0 ? i + 1 : undefined;
}

export function fingerprint(root: string, file: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(absPath(root, file))).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}
