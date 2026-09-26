import type { Box } from "../cube";
import { loadBoxState } from "../state/state";
import { CUBE_DIR } from "../paths";
import type { ReadRecord } from "../logs/extract";
import type { EditRecord } from "../logs/store";
import type { AgentActivity } from "../logs/transcript";
import { idKey } from "../format/ids";

/**
 * Reading controls what enters the agent's context, not what leaves it: a box
 * opened for nothing stays in the context for the rest of the session. This
 * finds boxes that were opened but show no sign of use afterwards. A box counts
 * as used when, after it was first opened, the agent named it or something it
 * lists (its id, a code name, a file), read or edited a file it lists, or
 * opened a box linked to it. It's a rough signal, tilted toward "used": a box
 * that is often opened without use has a read-when line that's too broad.
 */

export interface OpenedBox {
  box: string;
  tokens: number;
  used: boolean;
}

const GENERIC_BASE = /^(index|main|utils?|types?|mod|lib|app|config|constants?)\.\w+$/i;

function needles(root: string, box: Box): string[] {
  const st = loadBoxState(root, box.id);
  const files = [...(st?.code?.files ?? []).map((f) => f.path), ...(st?.code?.commits ?? []).flatMap((c) => c.files)];
  const out = new Set<string>([box.id]);
  if (box.name.length >= 8) out.add(box.name);
  for (const n of st?.names ?? []) if (n.length >= 4) out.add(n);
  for (const f of files) {
    out.add(f);
    const base = f.split("/").pop()!;
    if (base.length >= 6 && !GENERIC_BASE.test(base)) out.add(base);
  }
  return [...out].map((s) => s.toLowerCase());
}

function codeFiles(root: string, box: Box): Set<string> {
  const st = loadBoxState(root, box.id);
  return new Set([...(st?.code?.files ?? []).map((f) => f.path), ...(st?.code?.commits ?? []).flatMap((c) => c.files)]);
}

/** Tool calls that only move around the cube (reading it, running its commands) aren't use. */
function isNavigation(a: AgentActivity): boolean {
  return !!a.tool && (a.text.includes(`${CUBE_DIR}/`) || a.text.includes("cube.mjs"));
}

export function openedBoxes(
  root: string,
  touched: { box: Box; first: string; tokens: number }[],
  reads: ReadRecord[],
  edits: EditRecord[],
  activity: AgentActivity[],
): OpenedBox[] {
  const firstOpen = new Map(touched.map((x) => [x.box.id, x.first]));
  const linksTo = (a: Box, b: Box) => (a.header?.links ?? []).some((l) => idKey(l.to) === idKey(b.id));
  const linked = (a: Box, b: Box) => linksTo(a, b) || linksTo(b, a);
  const acts = activity.filter((a) => !isNavigation(a)).map((a) => ({ t: a.t, text: a.text.toLowerCase() }));
  return touched.map(({ box, first, tokens }) => {
    const ns = needles(root, box);
    const files = codeFiles(root, box);
    const named = acts.some((a) => a.t >= first && ns.some((n) => a.text.includes(n)));
    const touchedCode =
      reads.some((r) => r.t >= first && r.tool !== "Instructions" && files.has(r.file)) || edits.some((e) => e.t >= first && files.has(e.file));
    const followed = touched.some((o) => o.box.id !== box.id && (firstOpen.get(o.box.id) ?? "") > first && linked(box, o.box));
    return { box: box.id, tokens, used: named || touchedCode || followed };
  });
}
