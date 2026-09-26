import type { Range } from "./extract";

/** Merges overlapping or touching 1-based inclusive ranges. */
export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.filter((r) => r[1] >= r[0]).map((r) => [r[0], r[1]] as Range).sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

/** The parts of 1..total not covered by `ranges`. */
export function complementRanges(ranges: Range[], total: number): Range[] {
  const merged = mergeRanges(ranges.map((r) => [Math.max(1, r[0]), Math.min(total, r[1])] as Range));
  const out: Range[] = [];
  let next = 1;
  for (const [a, b] of merged) {
    if (a > next) out.push([next, a - 1]);
    next = Math.max(next, b + 1);
  }
  if (next <= total) out.push([next, total]);
  return out;
}

export function rangeLength(ranges: Range[]): number {
  return mergeRanges(ranges).reduce((s, [a, b]) => s + (b - a + 1), 0);
}

export function fmtRanges(ranges: Range[], max = 6): string {
  const parts = ranges.map(([a, b]) => (a === b ? `${a.toLocaleString("en-US")}` : `${a.toLocaleString("en-US")}–${b.toLocaleString("en-US")}`));
  if (parts.length <= max) return parts.join(", ");
  return `${parts.slice(0, max).join(", ")}, … (${parts.length - max} more)`;
}
