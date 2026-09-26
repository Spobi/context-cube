import { isAbsolute, resolve } from "node:path";
import { allBoxes, getBox, getRow, isCandidate, loadCube, type Box, type Cube } from "./cube";
import { exists, readTextOr } from "./fsutil";
import { splitGenerated } from "./format/generated";
import { parseDoc } from "./format/header";
import { FROM_RE } from "./build/place";
import { loadBoxState } from "./state/state";
import { relToRoot, CUBE_DIR } from "./paths";
import { invariantsFor } from "./stats/reads";
import { listOrder } from "./index/pages";

/**
 * Deterministic routing (no AI): what the cube holds about a file, a folder,
 * or a code name. Code already knows file → boxes → invariants → history, so
 * the agent shouldn't have to reason its way there. `find` searches the
 * cube's text on purpose, so ordinary code searches can leave it out.
 */

/** Matches a path against a glob: `**` any folders, `*` within one name, `?` one character. */
export function globMatch(glob: string, path: string): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(path);
}

export interface RelatedBox {
  id: string;
  name: string;
  summary: string;
  path: string;
  date?: string;
  /** How the cube got from the query to this box: the code it names, the commit, or the box it was reached through. */
  why: string[];
}

export interface Related {
  query: string;
  kind: "path" | "name";
  /** Approved invariants to read before editing. */
  invariants: RelatedBox[];
  /** Feature, system, catalog, and other boxes about it. */
  boxes: RelatedBox[];
  /** History entries that touched it, newest first. */
  history: RelatedBox[];
  /** Pending invariants: not approved, not rules. */
  candidates: RelatedBox[];
  /** Rules that load only with matching files. */
  rules: RelatedBox[];
}

function entry(box: Box, why: string[], drawer?: string): RelatedBox {
  return {
    id: box.id,
    name: box.name,
    summary: box.header?.summary ?? "",
    path: `${CUBE_DIR}/${box.relDir}/${drawer ?? ""}`,
    why,
  };
}

function commitsWhy(hashes: string[]): string {
  const shown = hashes.slice(0, 2).map((h) => h.slice(0, 7));
  const more = hashes.length > 2 ? ` and ${hashes.length - 2} more` : "";
  return `${hashes.length === 1 ? "commit" : "commits"} ${shown.join(", ")}${more} changed it`;
}

export function related(root: string, query: string, cwd = process.cwd(), cube: Cube = loadCube(root)): Related {
  const asPath = relToRoot(root, isAbsolute(query) ? query : resolve(cwd, query)).replace(/\/+$/, "");
  const out: Related = { query, kind: "name", invariants: [], boxes: [], history: [], candidates: [], rules: [] };
  const boxes = allBoxes(cube).filter((b) => !b.isRoot && b.header);
  const state = new Map(boxes.map((b) => [b.id, loadBoxState(root, b.id)]));
  const fileHit = (f: string) => f === asPath || f.startsWith(`${asPath}/`);
  // A path if it has a slash or exists; otherwise a code name, unless the cube knows it as a path.
  const isPath = /[\\/]/.test(query) || exists(resolve(cwd, query)) || boxes.some((b) => {
    const st = state.get(b.id);
    return (st?.code?.files ?? []).some((f) => fileHit(f.path)) || (st?.code?.commits ?? []).some((c) => c.files.some(fileHit));
  }) || boxes.some((b) => (b.header?.paths ?? []).some((g) => globMatch(g, asPath)));
  out.kind = isPath ? "path" : "name";

  /** Why a box's own text points at the query, or undefined if it doesn't. */
  const codeWhy = (b: Box): string | undefined => {
    const files = state.get(b.id)?.code?.files ?? [];
    if (out.kind === "path") {
      const f = files.find((x) => fileHit(x.path));
      if (!f) return undefined;
      const why = f.why.replace("named in the text", "names the file");
      return f.path === asPath ? why : `${f.path}: ${why}`;
    }
    const f = files.find((x) => x.why.includes(`\`${query}\``));
    if (f) return `names \`${query}\` (in ${f.path})`;
    return (state.get(b.id)?.names ?? []).includes(query) ? `names \`${query}\`` : undefined;
  };

  const why = new Map<string, string[]>();
  const because = (id: string, reason: string) => {
    const list = why.get(id) ?? [];
    if (!list.includes(reason)) list.push(reason);
    why.set(id, list);
  };
  const inv = new Map<string, Box>();
  const cand = new Map<string, Box>();
  const about: Box[] = [];
  const hist = new Map<string, Box>();
  for (const b of boxes) {
    const row = getRow(cube, b.rowNum)!;
    if (row.type === "rules") {
      const glob = out.kind === "path" ? (b.header?.paths ?? []).find((g) => globMatch(g, asPath)) : undefined;
      if (glob) out.rules.push(entry(b, [`loads with ${glob}`], "Z0-overview.md"));
      continue;
    }
    const code = codeWhy(b);
    if (row.type === "history") {
      const commits = out.kind === "path" ? (state.get(b.id)?.code?.commits ?? []).filter((c) => c.files.some(fileHit)).map((c) => c.hash) : [];
      if (commits.length) because(b.id, commitsWhy(commits));
      if (code) because(b.id, code);
      if (commits.length || code) hist.set(b.id, b);
      continue;
    }
    if (!code) continue;
    because(b.id, code);
    if (row.type === "invariants") (isCandidate(b) ? cand : inv).set(b.id, b);
    else about.push(b);
    for (const i of invariantsFor(cube, b)) {
      inv.set(i.id, i);
      if (i.id !== b.id) because(i.id, `via ${b.id}`);
    }
    for (const l of b.header?.links ?? []) {
      const t = getBox(cube, l.to);
      if (t && isCandidate(t)) {
        cand.set(t.id, t);
        because(t.id, `via ${b.id}`);
      }
    }
  }
  // History entries that link to a box about it touched it too.
  const aboutIds = new Set([...about, ...inv.values()].map((b) => b.id));
  for (const b of boxes) {
    if (getRow(cube, b.rowNum)?.type !== "history") continue;
    for (const l of b.header?.links ?? []) {
      const target = getBox(cube, l.to)?.id ?? l.to;
      if (!aboutIds.has(target)) continue;
      hist.set(b.id, b);
      because(b.id, `links to ${target}`);
    }
  }
  const reasons = (b: Box) => why.get(b.id) ?? [];
  out.invariants = [...inv.values()].map((b) => entry(b, reasons(b), "Z1-invariants.md"));
  out.candidates = [...cand.values()].map((b) => entry(b, reasons(b), "Z1-invariants.md"));
  out.boxes = about.map((b) => entry(b, reasons(b)));
  out.history = [...hist.values()]
    .sort((a, b) => b.num - a.num)
    .map((b) => ({ ...entry(b, reasons(b)), date: state.get(b.id)?.date }));
  return out;
}

export function renderRelated(r: Related, maxHistory = 8): string {
  const lines: string[] = [];
  const line = (b: RelatedBox) => `- ${b.id} ${b.name}${b.date ? ` (${b.date})` : ""}${b.why.length ? ` [${b.why.join("; ")}]` : ""}: ${b.summary} → ${b.path}`;
  const what = r.kind === "path" ? r.query : `\`${r.query}\``;
  if (!r.invariants.length && !r.boxes.length && !r.history.length && !r.candidates.length && !r.rules.length) {
    return `The cube has nothing linked to ${what}. To search its text: cube find "<words>"`;
  }
  lines.push(`What the cube holds about ${what} (in brackets: how each was found):`);
  if (r.invariants.length) lines.push("", "Invariants to read before editing it (Z1):", ...r.invariants.map(line));
  if (r.rules.length) lines.push("", "Rules for these files:", ...r.rules.map(line));
  if (r.boxes.length) lines.push("", "Boxes about it:", ...r.boxes.map(line));
  if (r.history.length) {
    lines.push("", "History that touched it (past records, newest first; open one only if the task needs the past):");
    lines.push(...r.history.slice(0, maxHistory).map(line));
    if (r.history.length > maxHistory) lines.push(`- …and ${r.history.length - maxHistory} older: ${r.history.slice(maxHistory).map((b) => b.id).join(", ")}`);
  }
  if (r.candidates.length) lines.push("", "Candidate invariants (not approved by a person; not rules):", ...r.candidates.map(line));
  return lines.join("\n");
}

// ---------- find: search the cube's text on purpose ----------

export interface FindHit {
  id: string;
  name: string;
  label: string;
  summary: string;
  path: string;
  lines: string[];
  hits: number;
}

/** A drawer's own text; for Z0, the read-when line and body (the summary is shown with every hit anyway). */
function ownText(z: number, raw: string): string {
  if (z === 0) {
    const doc = parseDoc(raw);
    return [doc.header?.read_when ? `Read when: ${doc.header.read_when}` : "", splitGenerated(doc.body).own].join("\n");
  }
  return splitGenerated(raw).own.replace(FROM_RE, "$4");
}

/** Boxes whose own text contains every word of the query (case-insensitive), best first. */
export function find(root: string, query: string, cube: Cube = loadCube(root)): FindHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: FindHit[] = [];
  for (const row of cube.rows) {
    for (const box of listOrder(row)) {
      if (!box.header) continue;
      const found: string[] = [];
      let all = box.header.summary.toLowerCase();
      let count = 0;
      for (const d of box.drawers) {
        const text = ownText(d.z, readTextOr(d.path, ""));
        all += `\n${text.toLowerCase()}`;
        for (const l of text.split("\n")) {
          const low = l.toLowerCase();
          if (!words.some((w) => low.includes(w))) continue;
          count++;
          if (found.length < 2 && l.trim()) found.push(`Z${d.z}: ${l.trim().slice(0, 160)}`);
        }
      }
      if (!words.every((w) => all.includes(w))) continue;
      count += words.filter((w) => box.header!.summary.toLowerCase().includes(w)).length;
      const label = row.type === "history" ? "past record" : isCandidate(box) ? "candidate, not approved" : row.type;
      hits.push({ id: box.id, name: box.name, label, summary: box.header.summary, path: `${CUBE_DIR}/${box.relDir}/`, lines: found, hits: count });
    }
  }
  return hits.sort((a, b) => b.hits - a.hits);
}

export function renderFind(query: string, hits: FindHit[], max = 15): string {
  if (!hits.length) return `Nothing in the cube mentions "${query}".`;
  const out = [`${hits.length} box${hits.length === 1 ? " mentions" : "es mention"} "${query}" (most mentions first):`];
  for (const h of hits.slice(0, max)) {
    out.push(`- ${h.id} ${h.name} [${h.label}]: ${h.summary} → ${h.path}`);
    for (const l of h.lines) out.push(`    ${l}`);
  }
  if (hits.length > max) out.push(`- …and ${hits.length - max} more: ${hits.slice(max).map((h) => h.id).join(", ")}. Use more words to narrow it.`);
  return out.join("\n");
}
