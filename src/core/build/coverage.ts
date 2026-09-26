import { join } from "node:path";
import { readTextOr } from "../fsutil";
import { allBoxes, loadCube } from "../cube";
import { DRAWERS } from "../format/drawers";
import { parseDoc } from "../format/header";
import { splitGenerated } from "../format/generated";
import { loadBoxState } from "../state/state";
import { splitLines } from "./markdown";
import { FROM_RE } from "./place";
import { readSource } from "./sources";

/**
 * Coverage after placement (pipeline step 13): recombines the migrated text
 * from the drawers where it now lives and checks that it reproduces each
 * source file exactly (line endings normalized). Proves every source line is
 * in exactly one place.
 */

export interface PlacedCoverage {
  source: string;
  ok: boolean;
  lines: number;
  problem?: string;
  /** Pieces whose drawer text no longer matches the source (e.g. an approved edit). */
  changed: { box: string; drawer: number; start: number; end: number }[];
}

interface Piece {
  box: string;
  drawer: number;
  start: number;
  end: number;
  text?: string;
}

export function drawerOwnText(path: string, z: number): string {
  const raw = readTextOr(path, "");
  const body = z === 0 ? parseDoc(raw).body : raw;
  return splitGenerated(body).own;
}

export function placedCoverage(root: string, sources: string[]): PlacedCoverage[] {
  const cube = loadCube(root);
  const pieces = new Map<string, Piece[]>();
  for (const box of allBoxes(cube)) {
    const st = loadBoxState(root, box.id);
    if (!st?.sources?.length) continue;
    const byDrawer = new Map<number, typeof st.sources>();
    for (const s of st.sources) byDrawer.set(s.drawer, [...(byDrawer.get(s.drawer) ?? []), s]);
    for (const [z, list] of byDrawer) {
      const own = drawerOwnText(join(box.dir, DRAWERS[z].file), z);
      const wrapped = new Map<string, string>();
      for (const m of own.matchAll(FROM_RE)) wrapped.set(`${m[1]}|${m[2]}|${m[3]}`, m[4]);
      for (const s of list) {
        const text = s.wrapped || list.length > 1 ? wrapped.get(`${s.file}|${s.start}|${s.end}`) : own;
        const arr = pieces.get(s.file) ?? [];
        arr.push({ box: box.id, drawer: z, start: s.start, end: s.end, text });
        pieces.set(s.file, arr);
      }
    }
  }
  return sources.map((source) => {
    // An archived source is read from the archive (readSource).
    const text = readSource(root, source);
    const lines = splitLines(text);
    const mine = (pieces.get(source) ?? []).sort((a, b) => a.start - b.start);
    const changed: PlacedCoverage["changed"] = [];
    let next = 1;
    for (const p of mine) {
      if (p.start !== next) {
        return { source, ok: false, lines: lines.length, changed, problem: `lines ${next}–${p.start - 1} are ${p.start > next ? "not in any drawer" : "in two places"}` };
      }
      const want = `${lines.slice(p.start - 1, p.end).join("\n")}\n`;
      if (p.text === undefined) {
        return { source, ok: false, lines: lines.length, changed, problem: `the piece at lines ${p.start}–${p.end} is missing from ${p.box}.Z${p.drawer}` };
      }
      if (p.text !== want) changed.push({ box: p.box, drawer: p.drawer, start: p.start, end: p.end });
      next = p.end + 1;
    }
    if (next !== lines.length + 1) return { source, ok: false, lines: lines.length, changed, problem: `lines ${next}–${lines.length} are not in any drawer` };
    if (changed.length) {
      return { source, ok: false, lines: lines.length, changed, problem: `${changed.length} piece${changed.length === 1 ? "" : "s"} no longer match the source word for word (first: ${changed[0].box}.Z${changed[0].drawer}, lines ${changed[0].start}–${changed[0].end})` };
    }
    return { source, ok: true, lines: lines.length, changed };
  });
}
