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
  text: Map<string, string>;
}

export function isCodeFile(path: string): boolean {
  return CODE_EXT.test(path) && !isMarkdown(path);
}

export function buildCodeIndex(root: string, files: string[] = listProjectFiles(root)): CodeIndex {
  const idx: CodeIndex = { files: [], fileSet: new Set(files), byBase: new Map(), text: new Map() };
  for (const f of files) {
    const base = f.split("/").pop()!;
    idx.byBase.set(base, [...(idx.byBase.get(base) ?? []), f]);
    if (!isCodeFile(f)) continue;
    const abs = absPath(root, f);
    if (fileSize(abs) > 2_000_000 || isBinary(abs)) continue;
    try {
      idx.text.set(f, normalizeEol(readFileSync(abs, "utf8")));
      idx.files.push(f);
    } catch {
      // unreadable; skip
    }
  }
  return idx;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Code files where `name` appears as a whole word. */
export function filesWithName(idx: CodeIndex, name: string, limit = 50): string[] {
  const re = new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`);
  const out: string[] = [];
  for (const f of idx.files) {
    if (re.test(idx.text.get(f)!)) {
      out.push(f);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** The first line in `file` where `name` appears, for a one-line reason. */
export function lineWith(idx: CodeIndex, file: string, name: string): number | undefined {
  const text = idx.text.get(file);
  if (!text) return undefined;
  const re = new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`);
  const lines = text.split("\n");
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
