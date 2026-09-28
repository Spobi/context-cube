import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { allBoxes, getBox, getRow, isCandidate, loadCube, type Box, type Cube, type Row } from "../cube";
import { loadConfig } from "../config";
import { CUBE_DIR } from "../paths";
import { estimateTokens, fmtApprox, fmtInt } from "../tokens";
import { loadBoxState } from "../state/state";
import { loadEdits, loadReads, loadSessions, type EditRecord } from "../logs/store";
import type { ReadRecord } from "../logs/extract";
import { categorize } from "../logs/report";
import { detectMemoryFiles } from "../logs/memoryFiles";
import { readTextOr } from "../fsutil";
import { extractBlock } from "../index/block";
import { readAgentActivity, type AgentActivity } from "../logs/transcript";
import { openedBoxes, type OpenedBox } from "./unused";
import { governingByFile, STRONG } from "../code/governs";

/**
 * What was read (plan 10). Compares what the agent read with what reading the
 * same areas in full would have taken. All figures are estimates (characters ÷
 * charsPerToken). It reports two comparisons, a conservative estimate and an
 * upper bound, and never claims "savings".
 */

export interface Miss {
  file: string;
  box: string;
  invariants: string[];
}

export interface SessionStats {
  session: string;
  start: string;
  read: number;
  conservative: number;
  upper: number;
  rowsTouched: string[];
  boxesTouched: string[];
  misses: Miss[];
  /** Boxes opened, and whether each shows signs of use. Undefined without a transcript. */
  opened?: OpenedBox[];
}

export interface StatsReport {
  sessions: SessionStats[];
  before?: { sessions: number; medianMemoryTokens: number };
  reach: { under30: number; days30to90: number; over90: number; undated: number };
  cubeSince?: string;
  charsPerToken: number;
}

interface CubeFile {
  /** index: a row index page. drawer: a box's drawer. root: a row root's drawer. cube: any other cube file (CUBE.md). */
  kind: "index" | "drawer" | "root" | "cube" | "other";
  row?: Row;
  box?: Box;
}

function classify(cube: Cube, rel: string): CubeFile {
  if (!rel.startsWith(`${CUBE_DIR}/`)) return { kind: "other" };
  const parts = rel.slice(CUBE_DIR.length + 1).split("/");
  const row = cube.rows.find((r) => r.relDir === parts[0]);
  if (!row) return { kind: "cube" };
  if (parts.length === 2 && /^ROW(-p\d+)?\.md$/.test(parts[1])) return { kind: "index", row };
  const box = row.allBoxes.find((b) => b.relDir === `${parts[0]}/${parts[1]}`);
  if (!box) return { kind: "cube", row };
  return { kind: box.isRoot ? "root" : "drawer", row, box };
}

function fileTokens(path: string, cpt: number): number {
  try {
    return estimateTokens(statSync(path).size, cpt);
  } catch {
    return 0;
  }
}

function indexPages(row: Row): string[] {
  try {
    return readdirSync(row.dir).filter((f) => /^ROW(-p\d+)?\.md$/.test(f)).map((f) => join(row.dir, f));
  } catch {
    return [];
  }
}

/** Approved invariants that govern a box: its own Z1 in an invariants row, or links to invariants boxes. Candidates don't count. */
export { invariantsFor } from "../code/governs";

/** When the cube was first built here: the earliest box state. */
export function cubeSince(root: string, cube: Cube): string | undefined {
  let min: string | undefined;
  for (const b of allBoxes(cube)) {
    const c = loadBoxState(root, b.id)?.created;
    if (c && (!min || c < min)) min = c;
  }
  return min;
}

export function computeStats(
  root: string,
  opts: { reads?: ReadRecord[]; edits?: EditRecord[]; now?: Date; activity?: Map<string, AgentActivity[]> } = {},
): StatsReport {
  const cube = loadCube(root);
  const config = loadConfig(root);
  const cpt = config.tokens.charsPerToken;
  const reads = opts.reads ?? loadReads(root);
  const edits = opts.edits ?? loadEdits(root);
  const since = cubeSince(root, cube);
  const memory = new Set(config.memoryFiles ?? detectMemoryFiles(root));
  const now = opts.now ?? new Date();

  // The invariants that govern each code file, for "possible misses".
  const governs = governingByFile(cube);

  const bySession = new Map<string, ReadRecord[]>();
  for (const r of reads) bySession.set(r.session, [...(bySession.get(r.session) ?? []), r]);
  const editsBySession = new Map<string, EditRecord[]>();
  for (const e of edits) editsBySession.set(e.session, [...(editsBySession.get(e.session) ?? []), e]);

  // Each session's transcript, for signs of what was used.
  const transcripts = new Map<string, string>();
  for (const s of loadSessions(root)) if (s.transcript) transcripts.set(s.session, s.transcript);
  const activityFor = (session: string): AgentActivity[] | undefined => {
    if (opts.activity) return opts.activity.get(session);
    const t = transcripts.get(session);
    return t ? readAgentActivity(t) : undefined;
  };

  const sessions: SessionStats[] = [];
  const beforeMemory: number[] = [];
  const reach = { under30: 0, days30to90: 0, over90: 0, undated: 0 };

  for (const [session, rs] of bySession) {
    const start = rs.reduce((m, r) => (r.t < m ? r.t : m), rs[0].t);
    if (since && start < since) {
      beforeMemory.push(rs.filter((r) => categorize(r.file, memory) === "memory").reduce((n, r) => n + r.tokens, 0));
      continue;
    }
    let read = 0;
    const touchedRows = new Set<Row>();
    const touchedBoxes = new Set<Box>();
    const indexRead = new Map<Row, Set<string>>();
    /** When each cube file was first opened. */
    const firstOpened = new Map<string, string>();
    const boxFirst = new Map<Box, string>();
    const boxTokensRead = new Map<Box, number>();
    for (const r of rs) {
      if (r.tool === "Instructions") {
        read += r.tokens; // CLAUDE.md with the always-loaded block, rule files: all counted
        continue;
      }
      const c = classify(cube, r.file);
      if (c.kind === "other") {
        if (categorize(r.file, memory) === "memory") read += r.tokens; // non-cube memory files still count
        continue;
      }
      read += r.tokens; // cube files: every read, repeats included
      if (!firstOpened.has(r.file) || r.t < firstOpened.get(r.file)!) firstOpened.set(r.file, r.t);
      if (c.kind === "index") {
        touchedRows.add(c.row!);
        indexRead.set(c.row!, new Set([...(indexRead.get(c.row!) ?? []), join(root, r.file)]));
      } else if (c.kind === "drawer") {
        touchedRows.add(c.row!);
        touchedBoxes.add(c.box!);
        if (!boxFirst.has(c.box!) || r.t < boxFirst.get(c.box!)!) boxFirst.set(c.box!, r.t);
        boxTokensRead.set(c.box!, (boxTokensRead.get(c.box!) ?? 0) + r.tokens);
      }
    }
    // Conservative: per touched row, the index pages read + every drawer of every touched box, once each.
    let conservative = 0;
    for (const row of touchedRows) {
      for (const p of indexRead.get(row) ?? []) conservative += fileTokens(p, cpt);
      for (const b of touchedBoxes) if (b.rowNum === row.num) for (const d of b.drawers) conservative += fileTokens(d.path, cpt);
    }
    // Upper bound: every file in every touched row, once each.
    let upper = 0;
    for (const row of touchedRows) {
      for (const p of indexPages(row)) upper += fileTokens(p, cpt);
      for (const b of row.allBoxes) for (const d of b.drawers) upper += fileTokens(d.path, cpt);
    }
    // Possible misses: an edited file that invariants govern, where the agent hadn't opened
    // their Z1 before its first edit there. A path rule loading doesn't count: it's a
    // one-line pointer that loads whenever the file is read, and a file is read before it's edited.
    const misses: Miss[] = [];
    const firstEdit = new Map<string, string>();
    for (const e of editsBySession.get(session) ?? []) if (!firstEdit.has(e.file) || e.t < firstEdit.get(e.file)!) firstEdit.set(e.file, e.t);
    for (const [file, t] of firstEdit) {
      const governing = governs.get(file) ?? [];
      const unread = governing.filter((g) => {
        const at = firstOpened.get(`${CUBE_DIR}/${g.inv.relDir}/Z1-invariants.md`);
        return !at || at > t;
      });
      if (!unread.length) continue;
      misses.push({ file, box: unread.flatMap((g) => g.via)[0] ?? unread[0].inv.id, invariants: unread.map((g) => g.inv.id) });
    }
    // Reach: boxes opened, by the age of what they hold.
    for (const b of touchedBoxes) {
      const st = loadBoxState(root, b.id);
      const date = st?.date ?? st?.created;
      if (!date) {
        reach.undated++;
        continue;
      }
      const days = (now.getTime() - new Date(date).getTime()) / 86_400_000;
      if (days < 30) reach.under30++;
      else if (days <= 90) reach.days30to90++;
      else reach.over90++;
    }
    const activity = touchedBoxes.size ? activityFor(session) : undefined;
    const opened = activity
      ? openedBoxes(
          root,
          [...touchedBoxes].map((b) => ({ box: b, first: boxFirst.get(b)!, tokens: boxTokensRead.get(b) ?? 0 })),
          rs,
          editsBySession.get(session) ?? [],
          activity,
        )
      : touchedBoxes.size
        ? undefined
        : [];
    sessions.push({
      session,
      start,
      read,
      conservative,
      upper,
      rowsTouched: [...touchedRows].sort((a, b) => a.num - b.num).map((r) => r.name),
      boxesTouched: [...touchedBoxes].map((b) => b.id).sort(),
      misses,
      opened,
    });
  }
  sessions.sort((a, b) => a.start.localeCompare(b.start));
  const med = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return {
    sessions,
    before: beforeMemory.length ? { sessions: beforeMemory.length, medianMemoryTokens: med(beforeMemory) } : undefined,
    reach,
    cubeSince: since,
    charsPerToken: cpt,
  };
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function unusedLine(s: SessionStats): string {
  if (!s.opened) return "unknown (no transcript)";
  const u = s.opened.filter((o) => !o.used);
  if (!u.length) return `0 of ${s.opened.length} boxes opened`;
  return `${u.length} of ${s.opened.length} boxes opened, ~${fmtInt(u.reduce((n, o) => n + o.tokens, 0))} tokens (${u.map((o) => o.box).join(", ")})`;
}

// Quality first: whether the right things were read (misses) and whether what was read was used, then the size.
function sessionBlock(s: SessionStats, title: string): string[] {
  return [
    title,
    `  Possible misses: ${s.misses.length}${s.misses.length ? ` (${s.misses.map((m) => `${m.file} → ${m.invariants.join(", ")}`).join("; ")})` : ""}`,
    `  Opened, possibly unused: ${unusedLine(s)}`,
    `  Read:                              ${fmtInt(s.read)} tokens`,
    `  Same areas without the cube:  ${fmtApprox(s.conservative)} (conservative) to ${fmtApprox(s.upper)} (full rows)`,
    `  Rows touched: ${s.rowsTouched.join(", ") || "none"}`,
  ];
}

/** Boxes opened in at least two sessions and unused in most of them: their read-when lines may be too broad. */
export function oftenUnused(sessions: SessionStats[]): { box: string; opened: number; unused: number }[] {
  const count = new Map<string, { opened: number; unused: number }>();
  for (const s of sessions) {
    for (const o of s.opened ?? []) {
      const c = count.get(o.box) ?? { opened: 0, unused: 0 };
      c.opened++;
      if (!o.used) c.unused++;
      count.set(o.box, c);
    }
  }
  return [...count]
    .filter(([, c]) => c.opened >= 2 && c.unused / c.opened >= 0.5)
    .map(([box, c]) => ({ box, ...c }))
    .sort((a, b) => b.unused - a.unused || a.box.localeCompare(b.box));
}

export function renderStats(r: StatsReport, opts: { all?: boolean } = {}): string {
  const out: string[] = [];
  if (!r.sessions.length) {
    out.push("No sessions logged since the cube was installed. The read logger records them: cube log install");
  } else {
    const last = r.sessions[r.sessions.length - 1];
    if (opts.all) for (const s of r.sessions) out.push(...sessionBlock(s, `Session ${s.session.slice(0, 8)} (${s.start.slice(0, 10)})`), "");
    else out.push(...sessionBlock(last, `Project context this session (${last.start.slice(0, 10)}, ${last.session.slice(0, 8)})`), "");
    const n = r.sessions.length;
    out.push(`All ${n} session${n === 1 ? "" : "s"} since the cube was installed (median per session)`);
    out.push(`  Read:                              ${fmtInt(median(r.sessions.map((s) => s.read)))} tokens`);
    out.push(`  Same areas without the cube:  ${fmtApprox(median(r.sessions.map((s) => s.conservative)))} (conservative) to ${fmtApprox(median(r.sessions.map((s) => s.upper)))} (full rows)`);
    const misses = r.sessions.reduce((k, s) => k + s.misses.length, 0);
    out.push(`  Possible misses: ${misses} in all`);
    const known = r.sessions.filter((s) => s.opened);
    if (known.length) {
      const opened = known.reduce((k, s) => k + s.opened!.length, 0);
      const unused = known.reduce((k, s) => k + s.opened!.filter((o) => !o.used).length, 0);
      out.push(`  Opened, possibly unused: ${unused} of ${opened} box openings (${known.length} session${known.length === 1 ? "" : "s"} with a transcript)`);
      const often = oftenUnused(r.sessions).slice(0, 5);
      if (often.length) out.push(`  Often opened without apparent use (read-when may be too broad): ${often.map((o) => `${o.box} (${o.unused} of ${o.opened})`).join(", ")}`);
    }
    out.push(`  Reach (boxes opened, by the age of what they hold): under 30 days ${r.reach.under30}, 30–90 days ${r.reach.days30to90}, over 90 days ${r.reach.over90}${r.reach.undated ? `, undated ${r.reach.undated}` : ""}`);
  }
  if (r.before) out.push(`  Measured before the cube: ${fmtInt(r.before.medianMemoryTokens)} tokens per session read from memory files (median of ${r.before.sessions} session${r.before.sessions === 1 ? "" : "s"})`);
  out.push(`All figures are estimates (characters ÷ ${r.charsPerToken}). A possible miss is a file edited before the invariants that govern it were opened (the one-line rule that loads with the file doesn't count). "Without the cube" is what reading the same areas in full would have taken. "Possibly unused" means nothing the box names came up again after it was opened; it's a rough signal.`);
  return out.join("\n");
}

/** The always-loaded block's size, for reference. */
export function blockTokens(root: string, cpt = 4): number {
  const b = extractBlock(readTextOr(join(root, "CLAUDE.md"), "")) ?? extractBlock(readTextOr(join(root, "AGENTS.md"), "")) ?? "";
  return estimateTokens(b.length, cpt);
}
