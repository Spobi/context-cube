import { normalizeEol, readTextOr } from "../fsutil";
import { absPath, fileSize, isBinary, isMarkdown, listProjectFiles } from "../scan";
import { git, gitRoot } from "../git";

/**
 * A cheap code outline for the row-structure step (plan 6.7): folders, files,
 * sizes, top-level names found by pattern, and git activity. No AI.
 */

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|swift|kt|kts|java|py|rb|go|rs|c|cc|cpp|h|hpp|m|mm|cs|php|scala|sql|sh|vue|svelte|dart|ex|exs|lua)$/i;

const NAME_PATTERNS: [RegExp, RegExp][] = [
  [/\.(ts|tsx|js|jsx|mjs|cjs)$/i, /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/],
  [/\.swift$/i, /^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+|final\s+|@\w+\s+)*(?:class|struct|enum|protocol|actor|extension)\s+([A-Za-z_][\w.]*)/],
  [/\.(kt|kts|java|scala|cs)$/i, /^\s*(?:public\s+|private\s+|internal\s+|abstract\s+|final\s+|data\s+|sealed\s+|open\s+)*(?:class|interface|object|enum|record)\s+([A-Za-z_]\w*)/],
  [/\.py$/i, /^(?:class|def|async def)\s+([A-Za-z_]\w*)/],
  [/\.go$/i, /^(?:func(?:\s+\([^)]*\))?|type)\s+([A-Za-z_]\w*)/],
  [/\.rs$/i, /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:fn|struct|enum|trait|mod)\s+([A-Za-z_]\w*)/],
  [/\.rb$/i, /^\s*(?:class|module|def)\s+([A-Za-z_][\w:.]*)/],
  [/\.sql$/i, /^\s*create\s+(?:or\s+replace\s+)?(?:table|function|view|type|trigger|policy|index)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i],
];

export function topNames(path: string, text: string, max = 12): string[] {
  const pat = NAME_PATTERNS.find(([ext]) => ext.test(path))?.[1];
  if (!pat) return [];
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = pat.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
    if (out.length >= max) break;
  }
  return out;
}

export interface CodeOutline {
  text: string;
  codeFiles: number;
  codeLines: number;
}

export function codeOutline(root: string, maxChars = 24_000): CodeOutline {
  const files = listProjectFiles(root).filter((f) => CODE_EXT.test(f) && !isMarkdown(f));
  const info = files
    .map((f) => {
      const abs = absPath(root, f);
      if (fileSize(abs) > 2_000_000 || isBinary(abs)) return undefined;
      const text = normalizeEol(readTextOr(abs, ""));
      return { path: f, lines: text.split("\n").length, names: topNames(f, text) };
    })
    .filter((x): x is { path: string; lines: number; names: string[] } => !!x);

  // Folder summary (two levels deep).
  const folders = new Map<string, { files: number; lines: number }>();
  for (const f of info) {
    const parts = f.path.split("/");
    const key = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length === 2 ? `${parts[0]}/` : "(root)";
    const cur = folders.get(key) ?? { files: 0, lines: 0 };
    cur.files++;
    cur.lines += f.lines;
    folders.set(key, cur);
  }
  const lines: string[] = ["Folders (code files, lines):"];
  for (const [k, v] of [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]))) lines.push(`  ${k} ${v.files} files, ${v.lines} lines`);

  // Files, largest first, with their top-level names.
  lines.push("", "Files (lines: top-level names):");
  const byPath = [...info].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of byPath) lines.push(`  ${f.path} (${f.lines})${f.names.length ? `: ${f.names.join(", ")}` : ""}`);

  // Git activity: most-changed files in recent history.
  if (gitRoot(root)) {
    const r = git(["log", "-n", "400", "--name-only", "--format="], root);
    if (r.ok) {
      const counts = new Map<string, number>();
      for (const p of r.stdout.split("\n").filter(Boolean)) counts.set(p, (counts.get(p) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
      if (top.length) lines.push("", "Most-changed files in the last 400 commits (changes):", ...top.map(([p, n]) => `  ${p} (${n})`));
    }
  }
  let text = lines.join("\n");
  if (text.length > maxChars) {
    // Keep folders and git activity; trim the file list to the largest files.
    const head = lines.slice(0, folders.size + 1).join("\n");
    const tail = text.slice(text.indexOf("\nMost-changed"));
    const biggest = [...info].sort((a, b) => b.lines - a.lines);
    const fileLines: string[] = [];
    let used = head.length + (tail.startsWith("\nMost") ? tail.length : 0) + 200;
    for (const f of biggest) {
      const l = `  ${f.path} (${f.lines})${f.names.length ? `: ${f.names.slice(0, 8).join(", ")}` : ""}`;
      if (used + l.length > maxChars) break;
      fileLines.push(l);
      used += l.length + 1;
    }
    text = `${head}\n\nLargest files (lines: top-level names; ${info.length - fileLines.length} smaller files not shown):\n${fileLines.sort().join("\n")}${tail.startsWith("\nMost") ? tail : ""}`;
  }
  return { text, codeFiles: info.length, codeLines: info.reduce((n, f) => n + f.lines, 0) };
}
