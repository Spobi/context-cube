/**
 * Just enough markdown structure for splitting: headings and top-level list
 * items, ignoring anything inside fenced code blocks.
 */

export interface Heading {
  /** 1-based line number. */
  line: number;
  level: number;
  text: string;
}

export interface LineInfo {
  text: string;
  inFence: boolean;
  heading?: Heading;
  /** A list item that starts at column 0 (`- x`, `* x`, `1. x`, `1) x`). */
  topItem: boolean;
  /** The === or --- line under an underlined heading. */
  underline?: boolean;
}

const FENCE_RE = /^\s{0,3}(```+|~~~+)/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const TOP_ITEM_RE = /^(?:[-*+]|\d+[.)])\s+\S/;

/** Splits text into lines. A final newline doesn't create an extra empty line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

export function analyze(text: string): LineInfo[] {
  const lines = splitLines(text);
  const out: LineInfo[] = [];
  let fence: string | undefined;
  // A YAML front-matter block at the top is data, not headings.
  let frontEnd = -1;
  if (lines[0] === "---") frontEnd = lines.findIndex((l, k) => k > 0 && (l === "---" || l === "..."));
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    if (i <= frontEnd) {
      out.push({ text: t, inFence: true, topItem: false });
      continue;
    }
    const f = FENCE_RE.exec(t);
    if (fence) {
      out.push({ text: t, inFence: true, topItem: false });
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && t.trim() === f[1]) fence = undefined;
      continue;
    }
    if (f) {
      fence = f[1];
      out.push({ text: t, inFence: true, topItem: false });
      continue;
    }
    const h = HEADING_RE.exec(t);
    if (h) {
      out.push({ text: t, inFence: false, topItem: false, heading: { line: i + 1, level: h[1].length, text: h[2] } });
      continue;
    }
    // Underlined (setext) headings: a line of text followed by === (level 1) or --- (level 2).
    const prev = out[i - 1];
    const u = /^ {0,3}(=+|-+)\s*$/.exec(t);
    if (u && prev && !prev.inFence && !prev.heading && !prev.topItem && prev.text.trim() !== "" && !/^\s{4}/.test(prev.text) && !isUnderline(prev.text)) {
      prev.heading = { line: i, level: u[1][0] === "=" ? 1 : 2, text: prev.text.trim() };
      out.push({ text: t, inFence: false, topItem: false, underline: true });
      continue;
    }
    out.push({ text: t, inFence: false, topItem: TOP_ITEM_RE.test(t) });
  }
  return out;
}

function isUnderline(t: string): boolean {
  return /^ {0,3}(=+|-+)\s*$/.test(t);
}

export function headings(text: string): Heading[] {
  return analyze(text).flatMap((l) => (l.heading ? [l.heading] : []));
}

/** Joins lines [start..end] (1-based, inclusive) back into text, with a trailing newline. */
export function sliceLines(lines: string[], start: number, end: number): string {
  if (end < start) return "";
  return `${lines.slice(start - 1, end).join("\n")}\n`;
}
