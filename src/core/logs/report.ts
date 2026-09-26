import { isAbsolute } from "node:path";
import { countLines, readTextOr } from "../fsutil";
import { fmtInt } from "../tokens";
import { CUBE_DIR } from "../paths";
import type { Range, ReadRecord } from "./extract";
import type { SessionRecord } from "./store";
import { complementRanges, fmtRanges, mergeRanges, rangeLength } from "./ranges";
import { absPath } from "../scan";

export type Category = "memory" | "cube" | "other" | "outside";

export const CATEGORY_LABELS: Record<Category, string> = {
  memory: "Memory files",
  cube: "Cube files",
  other: "Other project files",
  outside: "Outside the project",
};

export function categorize(file: string, memory: Set<string>): Category {
  if (!file) return "other";
  if (isAbsolute(file)) return "outside";
  if (file === CUBE_DIR || file.startsWith(`${CUBE_DIR}/`)) return "cube";
  if (memory.has(file)) return "memory";
  return "other";
}

export interface SessionSummary {
  session: string;
  first: string;
  last: string;
  tokens: Record<Category, number>;
  usage?: SessionRecord["usage"];
}

export interface MemoryFileSummary {
  file: string;
  currentLines: number;
  sessionsRead: number;
  tokens: number;
  everRead: Range[];
  neverRead: Range[];
  unknownRangeReads: number;
  /** Line counts seen at read time differed from today's, so ranges are approximate. */
  shifted: boolean;
}

export interface LogReport {
  sessions: SessionSummary[];
  memoryFiles: MemoryFileSummary[];
  from?: string;
  to?: string;
}

export function buildReport(root: string, reads: ReadRecord[], sessions: SessionRecord[], memoryFiles: string[]): LogReport {
  const memory = new Set(memoryFiles);
  const bySession = new Map<string, SessionSummary>();
  for (const r of reads) {
    let s = bySession.get(r.session);
    if (!s) {
      s = { session: r.session, first: r.t, last: r.t, tokens: { memory: 0, cube: 0, other: 0, outside: 0 } };
      bySession.set(r.session, s);
    }
    if (r.t < s.first) s.first = r.t;
    if (r.t > s.last) s.last = r.t;
    s.tokens[categorize(r.file, memory)] += r.tokens;
  }
  for (const e of sessions) {
    if (e.event !== "end") continue;
    const s = bySession.get(e.session);
    if (s && e.usage) s.usage = e.usage;
    else if (!s && e.usage) {
      bySession.set(e.session, { session: e.session, first: e.t, last: e.t, tokens: { memory: 0, cube: 0, other: 0, outside: 0 }, usage: e.usage });
    }
  }

  const memSummaries: MemoryFileSummary[] = [];
  for (const file of memoryFiles) {
    const fileReads = reads.filter((r) => r.file === file);
    const currentLines = countLines(readTextOr(absPath(root, file), ""));
    const ranges = fileReads.flatMap((r) => r.ranges ?? []);
    const everRead = mergeRanges(ranges.map(([a, b]) => [a, Math.min(b, Math.max(currentLines, a))] as Range));
    memSummaries.push({
      file,
      currentLines,
      sessionsRead: new Set(fileReads.map((r) => r.session)).size,
      tokens: fileReads.reduce((s, r) => s + r.tokens, 0),
      everRead,
      neverRead: currentLines ? complementRanges(everRead, currentLines) : [],
      unknownRangeReads: fileReads.filter((r) => !r.ranges).length,
      shifted: fileReads.some((r) => r.totalLines !== undefined && Math.abs(r.totalLines - currentLines) > 1),
    });
  }

  const list = [...bySession.values()].sort((a, b) => a.first.localeCompare(b.first));
  return {
    sessions: list,
    memoryFiles: memSummaries,
    from: list[0]?.first,
    to: list[list.length - 1]?.last,
  };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pad(s: string, n: number, right = false): string {
  return right ? s.padStart(n) : s.padEnd(n);
}

export function renderReport(report: LogReport, charsPerToken = 4): string {
  const out: string[] = [];
  const n = report.sessions.length;
  if (!n) {
    return "No reads logged yet. Start a Claude Code session in this project, then run this report again.";
  }
  const day = (t?: string) => (t ? t.slice(0, 10) : "?");
  out.push(`Read log: ${n} session${n === 1 ? "" : "s"}, ${day(report.from)} to ${day(report.to)}`);
  out.push(`All token figures are estimates (characters ÷ ${charsPerToken}), not exact counts.`);
  out.push("");
  out.push(`${pad("Per session", 26)}${pad("median", 10, true)}${pad("mean", 10, true)}${pad("max", 10, true)}`);
  for (const cat of ["memory", "cube", "other", "outside"] as Category[]) {
    const xs = report.sessions.map((s) => s.tokens[cat]);
    if (cat === "cube" && xs.every((x) => x === 0)) continue;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    out.push(
      `  ${pad(CATEGORY_LABELS[cat], 24)}${pad(fmtInt(median(xs)), 10, true)}${pad(fmtInt(mean), 10, true)}${pad(fmtInt(Math.max(...xs)), 10, true)}`,
    );
  }
  out.push("  (\"Outside the project\" is mostly your personal ~/.claude/CLAUDE.md.)");
  out.push("");
  out.push(`Memory files (${report.memoryFiles.length})`);
  for (const m of report.memoryFiles) {
    out.push(
      `  ${m.file}: ${fmtInt(m.currentLines)} lines, read in ${m.sessionsRead} of ${n} sessions, ~${fmtInt(m.tokens)} tokens in total`,
    );
    if (!m.currentLines) {
      out.push("    (file is now empty or missing)");
      continue;
    }
    if (m.everRead.length) out.push(`    lines ever read: ${fmtRanges(m.everRead)}`);
    const never = rangeLength(m.neverRead);
    if (never === 0) out.push("    every line has been read at least once");
    else if (!m.everRead.length) out.push(`    never read (all ${fmtInt(m.currentLines)} lines)`);
    else out.push(`    never read: ${fmtRanges(m.neverRead)} (${fmtInt(never)} lines, ${Math.round((100 * never) / m.currentLines)}%)`);
    if (m.unknownRangeReads) out.push(`    plus ${m.unknownRangeReads} read${m.unknownRangeReads === 1 ? "" : "s"} where the line range couldn't be told`);
    if (m.shifted) out.push("    note: the file changed length since some reads, so line numbers are approximate");
  }
  const withUsage = report.sessions.filter((s) => s.usage);
  if (withUsage.length) {
    out.push("");
    out.push(`Actual usage from session transcripts (${withUsage.length} of ${n} sessions)`);
    const peak = median(withUsage.map((s) => s.usage!.peakContextTokens));
    const calls = median(withUsage.map((s) => s.usage!.apiCalls));
    const memShare = median(
      withUsage.map((s) => (s.usage!.peakContextTokens ? s.tokens.memory / s.usage!.peakContextTokens : 0)),
    );
    out.push(`  median largest context: ${fmtInt(peak)} tokens over ${fmtInt(calls)} model calls`);
    out.push(`  memory-file reads were a median ~${Math.round(memShare * 100)}% of that largest context (estimate)`);
  }
  return out.join("\n");
}
