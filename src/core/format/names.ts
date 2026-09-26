/**
 * Short names (plan 3.1): a few lowercase words joined by hyphens (2–5 for
 * boxes; rows are often one word, like "history"). The coordinate is the
 * identity; the name is a label and may change.
 */

const STOP = new Set(["a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by", "is", "it", "be"]);

export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/;

export function isValidName(name: string): boolean {
  if (!NAME_RE.test(name)) return false;
  return name.length <= 60;
}

/**
 * Turns any text into a short name. Drops filler words when the text is long,
 * keeps at most `maxWords` words, and never returns an empty name.
 */
export function slugify(text: string, maxWords = 5): string {
  const words = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/§/g, "s")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let picked = words;
  if (words.length > maxWords) {
    const content = words.filter((w) => !STOP.has(w));
    picked = content.length >= 2 ? content : words;
  }
  picked = picked.slice(0, maxWords);
  if (!picked.length) return "untitled";
  return picked.join("-").slice(0, 60).replace(/-+$/, "");
}
