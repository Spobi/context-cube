/**
 * Inserts or replaces a marked block in a text file. Nothing outside the
 * markers is ever changed (plan 3.8).
 */

export const BLOCK_START = "<!-- context-cube:start -->";
export const BLOCK_END = "<!-- context-cube:end -->";

/** The separator added before a new block appended to `text`. */
export function blockSeparator(text: string): string {
  if (text === "" || text.endsWith("\n\n")) return "";
  return text.endsWith("\n") ? "\n" : "\n\n";
}

export function hasBlock(text: string, start = BLOCK_START, end = BLOCK_END): boolean {
  const s = text.indexOf(start);
  return s >= 0 && text.indexOf(end, s) > s;
}

export function upsertBlock(text: string, block: string, start = BLOCK_START, end = BLOCK_END): string {
  const body = `${start}\n${block.replace(/\n+$/, "")}\n${end}`;
  const s = text.indexOf(start);
  const e = s >= 0 ? text.indexOf(end, s) : -1;
  if (s >= 0 && e > s) {
    return text.slice(0, s) + body + text.slice(e + end.length);
  }
  return `${text}${blockSeparator(text)}${body}\n`;
}

/**
 * Removes the block. `sep` is the separator recorded when the block was first
 * added; removing it too restores the file's original bytes.
 */
export function removeBlock(text: string, sep?: string, start = BLOCK_START, end = BLOCK_END): string {
  const s = text.indexOf(start);
  const e = s >= 0 ? text.indexOf(end, s) : -1;
  if (s < 0 || e < s) return text;
  let before = text.slice(0, s);
  let after = text.slice(e + end.length);
  if (after.startsWith("\n")) after = after.slice(1);
  if (after === "") {
    const strip = sep ?? (before.endsWith("\n\n") ? "\n" : "");
    if (strip && before.endsWith(strip)) before = before.slice(0, before.length - strip.length);
  }
  return before + after;
}

export function extractBlock(text: string, start = BLOCK_START, end = BLOCK_END): string | undefined {
  const s = text.indexOf(start);
  const e = s >= 0 ? text.indexOf(end, s) : -1;
  if (s < 0 || e < s) return undefined;
  return text.slice(s + start.length, e).replace(/^\n/, "").replace(/\n$/, "");
}
