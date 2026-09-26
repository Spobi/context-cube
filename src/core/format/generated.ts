/**
 * Generated sections inside drawer files (plan 3.7): backlinks and other
 * tool-written text sit between these markers at the end of a file, and only
 * the tool edits them. Everything before the markers is the drawer's own text.
 */

export const GEN_START = "<!-- cube:generated:start -->";
export const GEN_END = "<!-- cube:generated:end -->";

export interface SplitDrawer {
  /** The drawer's own text, byte for byte. */
  own: string;
  /** The generated text between the markers, or undefined if there is none. */
  generated?: string;
}

/**
 * The generated section is appended as "\n" + START + "\n" + text + "\n" + END + "\n".
 * The leading "\n" is a separator owned by the section, so removing the section
 * returns the drawer's own text exactly.
 */
export function splitGenerated(text: string): SplitDrawer {
  const s = text.lastIndexOf(GEN_START);
  if (s < 0) return { own: text };
  const e = text.indexOf(GEN_END, s);
  if (e < 0) return { own: text };
  let own = text.slice(0, s);
  if (own.endsWith("\n\n")) own = own.slice(0, -1);
  else if (own === "\n") own = "";
  const generated = text.slice(s + GEN_START.length, e).replace(/^\n/, "").replace(/\n$/, "");
  return { own, generated };
}

export function joinGenerated(own: string, generated?: string): string {
  if (generated === undefined || generated.trim() === "") return own;
  const base = own === "" ? "" : own.endsWith("\n") ? own : `${own}\n`;
  return `${base}\n${GEN_START}\n${generated.replace(/\n+$/, "")}\n${GEN_END}\n`;
}
