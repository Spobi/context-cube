import { readTextOr, remove, writeText } from "../fsutil";
import { allBoxes, drawerPath, getBox, isCandidate, type Box, type Cube } from "../cube";
import { DRAWERS } from "../format/drawers";
import { joinGenerated, splitGenerated } from "../format/generated";
import { parseDoc } from "../format/header";
import { idKey } from "../format/ids";
import { loadBoxState, newBoxState, saveBoxState, sha } from "../state/state";
import { z2Text } from "../code/links";
import { fragmentsText } from "../history";

/**
 * Backlinks (plan 3.7) are how one entry, stored once, is reachable from every
 * row it affected:
 *   - Z1 of a box outside the invariants rows lists the invariants boxes it links to.
 *   - Z3 of a box outside the history rows lists the history entries that link to it.
 * Also generated: a candidate label on pending invariants (Z1), and a "past
 * record" note on closed history entries (Z4), so neither passes for current rules.
 */

export const CANDIDATE_NOTE =
  "Candidate, not approved: a person hasn't reviewed this yet, so it isn't a rule. Don't follow it or build on it as one; if your task conflicts with it, tell the person. `cube pending` lists it for approval.";

export function pastRecordNote(date?: string): string {
  return `Past record${date ? ` (${date})` : ""}: this describes the project as it was then. Where it disagrees with an invariant or the current code, the invariant and the code are current.`;
}

export function expectedGenerated(cube: Cube): Map<string, string> {
  const out = new Map<string, string>();
  const rowType = new Map(cube.rows.map((r) => [r.num, r.type]));
  const incomingFromHistory = new Map<string, { from: Box; note?: string }[]>();
  for (const box of allBoxes(cube)) {
    if (!box.header || rowType.get(box.rowNum) !== "history") continue;
    for (const l of box.header.links) {
      const key = idKey(l.to);
      if (!key) continue;
      const list = incomingFromHistory.get(key) ?? [];
      if (!list.some((x) => x.from.id === box.id)) list.push({ from: box, note: l.note });
      incomingFromHistory.set(key, list);
    }
  }
  for (const box of allBoxes(cube)) {
    const type = rowType.get(box.rowNum);
    const st = loadBoxState(cube.root, box.id);
    if (box.header && type !== "invariants") {
      const lines: string[] = [];
      for (const l of box.header.links) {
        const t = getBox(cube, l.to);
        if (!t || rowType.get(t.rowNum) !== "invariants") continue;
        const why = l.note ? `: ${l.note}` : t.header?.summary ? `: ${t.header.summary}` : "";
        lines.push(`- [[${t.id}]] ${t.name}${isCandidate(t) ? " (candidate, not approved)" : ""}${why}`);
      }
      if (lines.length) out.set(`${box.id}.Z1`, [`Invariants this links to:`, ...lines].join("\n"));
    }
    if (type === "invariants" && !box.isRoot && isCandidate(box)) out.set(`${box.id}.Z1`, CANDIDATE_NOTE);
    const z2 = z2Text(cube, box, st);
    if (z2) out.set(`${box.id}.Z2`, z2);
    if (type === "history" && box.header?.status === "open") {
      const z4 = fragmentsText(box);
      if (z4) out.set(`${box.id}.Z4`, z4);
    } else if (type === "history" && !box.isRoot && box.drawers.some((d) => d.z === 4)) {
      out.set(`${box.id}.Z4`, pastRecordNote(st?.date));
    }
    if (type !== "history") {
      const incoming = (incomingFromHistory.get(idKey(box.id)!) ?? []).sort((a, b) => b.from.num - a.from.num);
      if (incoming.length) {
        const lines = incoming.map(
          ({ from, note }) => `- [[${from.id}]] ${from.name}: ${note ?? from.header?.summary ?? ""}`.replace(/: $/, ""),
        );
        out.set(`${box.id}.Z3`, [`History entries that touched this (newest first; past records, so the invariants and code are current):`, ...lines].join("\n"));
      }
    }
  }
  return out;
}

/**
 * Writes the expected generated sections into drawer files, and records a
 * checksum of each in the box's state so `cube check` can tell a person's edit
 * from a section that is merely out of date. Returns files changed.
 */
export function writeGenerated(cube: Cube): number {
  const expected = expectedGenerated(cube);
  let changed = 0;
  for (const box of allBoxes(cube)) {
    const st = loadBoxState(cube.root, box.id) ?? newBoxState(box.id);
    const before = JSON.stringify(st.generated ?? {});
    const gen: Record<string, string> = {};
    for (const z of [1, 2, 3, 4]) {
      const want = expected.get(`${box.id}.Z${z}`);
      if (want !== undefined) gen[`Z${z}`] = sha(want);
      const path = drawerPath(box, z);
      const text = readTextOr(path, "");
      const { own, generated } = splitGenerated(text);
      if ((generated ?? undefined) === want) continue;
      const next = joinGenerated(own, want);
      if (next === "") remove(path);
      else writeText(path, next);
      changed++;
    }
    if (JSON.stringify(gen) !== before) {
      st.generated = Object.keys(gen).length ? gen : undefined;
      saveBoxState(cube.root, st);
    }
  }
  return changed;
}

/**
 * Drawers whose generated section was edited by hand: its text matches neither
 * what the tool last wrote nor what it would write now.
 */
export function editedGenerated(cube: Cube): { id: string; file: string }[] {
  const expected = expectedGenerated(cube);
  const out: { id: string; file: string }[] = [];
  for (const box of allBoxes(cube)) {
    const recorded = loadBoxState(cube.root, box.id)?.generated ?? {};
    for (const d of box.drawers) {
      const text = readTextOr(d.path, "");
      const body = d.z === 0 ? parseDoc(text).body : text;
      const { generated } = splitGenerated(body);
      if (generated === undefined) continue;
      if (d.z === 0) {
        out.push({ id: `${box.id}.Z${d.z}`, file: d.file });
        continue;
      }
      const want = expected.get(`${box.id}.Z${d.z}`);
      const last = recorded[`Z${d.z}`];
      if (generated === want || (last !== undefined && sha(generated) === last)) continue;
      out.push({ id: `${box.id}.Z${d.z}`, file: DRAWERS[d.z].file });
    }
  }
  return out;
}
