import { z } from "zod";
import type { Step } from "../runner";
import prompt from "../prompts/rows.md";

export const ProposedBox = z.object({ name: z.string(), summary: z.string(), readWhen: z.string() });

export const ProposedRow = z.object({
  name: z.string(),
  type: z.enum(["feature", "system", "catalog", "custom"]),
  summary: z.string(),
  readWhen: z.string(),
  conventions: z.array(z.string()).optional(),
  boxes: z.array(ProposedBox),
});

export const RowsOutput = z.object({
  rows: z.array(ProposedRow),
  place: z.array(z.object({ piece: z.string(), row: z.string(), box: z.string().optional() })),
});
export type RowsOut = z.infer<typeof RowsOutput>;

export interface PieceRef {
  id: string;
  source: string;
  title: string;
  lines: number;
}

export interface RowsIn {
  outline: string;
  fixed: { rules: string[]; history: string[]; invariants: string[] };
  pieces: PieceRef[];
  feedback?: string;
}

export const rowsStep: Step<RowsIn, RowsOut> = {
  name: "rows",
  prompt,
  schema: RowsOutput,
  render: (i) => {
    const bySource = new Map<string, PieceRef[]>();
    for (const p of i.pieces) bySource.set(p.source, [...(bySource.get(p.source) ?? []), p]);
    const parts = [
      "## Code outline",
      i.outline,
      "",
      "## Fixed rows (not yours to design)",
      `Rules (${i.fixed.rules.length}):`,
      ...i.fixed.rules.map((t) => `- ${t}`),
      "",
      `History entries (${i.fixed.history.length}, newest first):`,
      ...i.fixed.history.map((t) => `- ${t}`),
      "",
      `Invariants topics (${i.fixed.invariants.length}):`,
      ...i.fixed.invariants.map((t) => `- ${t}`),
      "",
      "## Notes and catalog pieces (place every one)",
    ];
    for (const [source, ps] of bySource) {
      parts.push(`From ${source}:`, ...ps.map((p) => `- ${p.id}: ${p.title} (${p.lines} lines)`));
    }
    if (!i.pieces.length) parts.push("(none)");
    if (i.feedback) parts.push("", "## Feedback on your previous proposal (from the person reviewing it)", i.feedback);
    return parts.join("\n");
  },
  validate: (out, input) => {
    const names = new Set(out.rows.map((r) => r.name));
    if (names.size !== out.rows.length) return "two rows have the same name";
    for (const fixed of ["rules", "history", "invariants"]) if (names.has(fixed)) return `"${fixed}" is a fixed row; don't propose it`;
    const want = new Set(input.pieces.map((p) => p.id));
    const placed = new Map<string, number>();
    for (const p of out.place) {
      if (!want.has(p.piece)) return `unknown piece "${p.piece}"`;
      if (!names.has(p.row)) return `piece ${p.piece} is placed in "${p.row}", which isn't one of your rows`;
      placed.set(p.piece, (placed.get(p.piece) ?? 0) + 1);
    }
    const boxUses = new Map<string, number>();
    for (const p of out.place) {
      if (!p.box) continue;
      const row = out.rows.find((r) => r.name === p.row)!;
      if (!row.boxes.some((b) => b.name === p.box)) return `piece ${p.piece} names box "${p.box}", which isn't one of the boxes you proposed in row "${p.row}"`;
      const k = `${p.row}/${p.box}`;
      boxUses.set(k, (boxUses.get(k) ?? 0) + 1);
    }
    const reused = [...boxUses.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    if (reused.length) return `these boxes were given more than one piece (use each box at most once): ${reused.join(", ")}`;
    const missing = [...want].filter((id) => !placed.has(id));
    if (missing.length) return `these pieces aren't placed: ${missing.slice(0, 30).join(", ")}${missing.length > 30 ? ` and ${missing.length - 30} more` : ""}`;
    const twice = [...placed.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    if (twice.length) return `these pieces are placed more than once: ${twice.slice(0, 20).join(", ")}`;
    if (out.rows.length > 60) return "too many rows; merge related ones (aim for 8–20 in a mid-size app)";
    return undefined;
  },
};
