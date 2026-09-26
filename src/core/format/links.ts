/** Inline references in drawer text: [[Y05.X004]], [[Y05.X004.Z1]], or [[Y05]]. */

export const INLINE_REF_RE = /\[\[(Y\d{2}(?:\.X\d{3,}(?:\.Z\d)?)?)\]\]/g;

export function findInlineRefs(text: string): string[] {
  return [...text.matchAll(INLINE_REF_RE)].map((m) => m[1]);
}

/** Rewrites inline refs using `map` (old id → new id). Drawer suffixes are kept. */
export function rewriteInlineRefs(text: string, rewrite: (id: string) => string | undefined): string {
  return text.replace(INLINE_REF_RE, (whole, id: string) => {
    const next = rewrite(id);
    return next ? `[[${next}]]` : whole;
  });
}
