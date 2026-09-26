import { isAbsolute, resolve } from "node:path";
import { isFile, readTextOr, countLines } from "../fsutil";
import { relToRoot } from "../paths";
import { estimateTokens } from "../tokens";
import { splitCommand, type ShellPart } from "./shell";

export type Range = [number, number];

/** One file's worth of content returned to the agent by one tool call. */
export interface ReadRecord {
  t: string;
  session: string;
  agent?: string;
  tool: "Read" | "Grep" | "Bash" | "Instructions";
  /** Path relative to the project root, or absolute when outside it. "" when unattributed. */
  file: string;
  /** 1-based inclusive line ranges returned. Missing when unknown. */
  ranges?: Range[];
  /** Line count of the file when it was read, if known. */
  totalLines?: number;
  chars: number;
  tokens: number;
  /** Instructions only: why the file loaded, and what triggered a path rule. */
  loadReason?: string;
  trigger?: string;
}

export interface HookInput {
  session_id?: string;
  cwd?: string;
  agent_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  file_path?: string;
  load_reason?: string;
  trigger_file_path?: string;
  [key: string]: unknown;
}

interface Ctx {
  root: string;
  cwd: string;
  session: string;
  agent?: string;
  t: string;
  charsPerToken: number;
}

function ctxFrom(input: HookInput, root: string, charsPerToken: number, now = new Date()): Ctx {
  return {
    root,
    cwd: input.cwd || root,
    session: input.session_id || "unknown",
    agent: input.agent_id || undefined,
    t: now.toISOString(),
    charsPerToken,
  };
}

function rec(ctx: Ctx, tool: ReadRecord["tool"], absFile: string, chars: number, extra: Partial<ReadRecord> = {}): ReadRecord {
  const r: ReadRecord = {
    t: ctx.t,
    session: ctx.session,
    tool,
    file: absFile ? relToRoot(ctx.root, absFile) : "",
    chars,
    tokens: estimateTokens(chars, ctx.charsPerToken),
    ...extra,
  };
  if (ctx.agent) r.agent = ctx.agent;
  return r;
}

function asObj(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      if (p && typeof p === "object") return p as Record<string, unknown>;
    } catch {
      // not JSON
    }
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Extracts file reads from a PostToolUse hook input. */
export function extractReads(input: HookInput, root: string, charsPerToken = 4, now?: Date): ReadRecord[] {
  const ctx = ctxFrom(input, root, charsPerToken, now);
  switch (input.tool_name) {
    case "Read":
      return extractRead(input, ctx);
    case "Grep":
      return extractGrep(input, ctx);
    case "Bash":
      return extractBash(input, ctx);
    default:
      return [];
  }
}

// ---------- Read ----------

function extractRead(input: HookInput, ctx: Ctx): ReadRecord[] {
  const resp = asObj(input.tool_response);
  const file = asObj(resp?.file);
  const toolInput = input.tool_input ?? {};
  const path = str(file?.filePath) ?? str(toolInput.file_path);
  if (!path) return [];
  const content = str(file?.content);
  if (content === undefined) {
    // Images, PDFs, notebooks: count the serialized response size, no line ranges.
    const size = typeof input.tool_response === "string" ? input.tool_response.length : JSON.stringify(input.tool_response ?? "").length;
    return [rec(ctx, "Read", resolve(ctx.cwd, path), size)];
  }
  const start = num(file?.startLine) ?? num(toolInput.offset) ?? 1;
  const total = num(file?.totalLines);
  // Claude Code counts lines by splitting on "\n", so a file ending in a newline
  // gets an empty last "line". Drop it only at the end of the file; elsewhere a
  // trailing "\n" means the last line returned was blank.
  let lines = num(file?.numLines) ?? content.split("\n").length;
  if (content.endsWith("\n") && total !== undefined && start + lines - 1 >= total && lines > 1) lines--;
  lines = Math.max(1, lines);
  const end = start + lines - 1;
  // The agent sees each line prefixed with its number and a tab; count that too.
  let prefix = 0;
  for (let n = start; n <= end; n++) prefix += String(n).length + 1;
  return [
    rec(ctx, "Read", resolve(ctx.cwd, path), content.length + prefix, {
      ranges: content.length ? [[start, end]] : [],
      totalLines: total,
    }),
  ];
}

// ---------- Grep ----------

function extractGrep(input: HookInput, ctx: Ctx): ReadRecord[] {
  const resp = asObj(input.tool_response);
  const toolInput = input.tool_input ?? {};
  const mode = str(resp?.mode) ?? str(toolInput.output_mode) ?? "files_with_matches";
  if (mode !== "content") return []; // file lists and counts don't return file content
  const content = str(resp?.content) ?? "";
  if (!content) return [];
  const searchPath = str(toolInput.path);
  const searchAbs = searchPath ? resolve(ctx.cwd, searchPath) : ctx.cwd;
  return attributeGrepLines(content, ctx, searchAbs, "Grep");
}

/**
 * Attributes grep/ripgrep output lines (`path:12:text`, `path-13-text`, `path:text`,
 * or `12:text` for a single-file search) to files.
 */
function attributeGrepLines(content: string, ctx: Ctx, searchAbs: string, tool: ReadRecord["tool"]): ReadRecord[] {
  const singleFile = isFile(searchAbs) ? searchAbs : undefined;
  const byFile = new Map<string, { chars: number; lines: number[] }>();
  const existsCache = new Map<string, string | undefined>();
  const resolveCandidate = (p: string): string | undefined => {
    if (existsCache.has(p)) return existsCache.get(p);
    let found: string | undefined;
    for (const base of [ctx.cwd, isFile(searchAbs) ? ctx.cwd : searchAbs, ctx.root]) {
      const abs = isAbsolute(p) ? p : resolve(base, p);
      if (isFile(abs)) {
        found = abs;
        break;
      }
    }
    existsCache.set(p, found);
    return found;
  };
  let unattributed = 0;
  for (const line of content.split("\n")) {
    if (line === "" || line === "--") continue;
    let file: string | undefined;
    let lineNo: number | undefined;
    if (singleFile) {
      file = singleFile;
      const m = /^(\d+)[:-]/.exec(line);
      if (m) lineNo = Number(m[1]);
    } else {
      const m = /^(.+?)([:-])(\d+)\2/.exec(line);
      if (m) {
        const f = resolveCandidate(m[1]);
        if (f) {
          file = f;
          lineNo = Number(m[3]);
        }
      }
      if (!file) {
        const idx = line.indexOf(":");
        if (idx > 0) file = resolveCandidate(line.slice(0, idx));
      }
    }
    if (!file) {
      unattributed += line.length + 1;
      continue;
    }
    const entry = byFile.get(file) ?? { chars: 0, lines: [] };
    entry.chars += line.length + 1;
    if (lineNo !== undefined) entry.lines.push(lineNo);
    byFile.set(file, entry);
  }
  const out: ReadRecord[] = [];
  for (const [file, e] of byFile) {
    out.push(rec(ctx, tool, file, e.chars, e.lines.length ? { ranges: toRanges(e.lines) } : {}));
  }
  if (unattributed > 0) out.push(rec(ctx, tool, "", unattributed));
  return out;
}

function toRanges(lines: number[]): Range[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: Range[] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

// ---------- Bash ----------

interface PlannedRead {
  file: string;
  ranges?: Range[];
  totalLines: number;
  /** Rough expected output lines, used to split stdout between several files. */
  weight: number;
}

const WHOLE_FILE_READERS = new Set(["cat", "nl", "less", "more", "bat", "batcat"]);

function extractBash(input: HookInput, ctx: Ctx): ReadRecord[] {
  const command = str(input.tool_input?.command);
  const resp = asObj(input.tool_response);
  const stdout = str(resp?.stdout) ?? (typeof input.tool_response === "string" ? input.tool_response : "");
  if (!command || !stdout) return [];
  const parts = splitCommand(command);
  if (!parts) return [];

  let cwd = ctx.cwd;
  const planned: PlannedRead[] = [];
  let grepPipeline: { searchAbs: string } | undefined;
  let i = 0;
  while (i < parts.length) {
    // Collect one pipeline.
    const pipeline: ShellPart[] = [parts[i]];
    while (parts[i].next === "|" && i + 1 < parts.length) {
      i++;
      pipeline.push(parts[i]);
    }
    i++;
    const first = stripWrappers(pipeline[0].words);
    if (first[0] === "cd" && pipeline.length === 1) {
      if (first[1]) cwd = resolve(cwd, first[1]);
      continue;
    }
    const reads = planReader(first, cwd);
    if (reads === "grep") {
      const target = grepTarget(first, cwd);
      if (target && pipeline.length === 1) grepPipeline = { searchAbs: target };
      continue;
    }
    if (!reads) continue;
    // Narrow by trailing `| head -n N` / `| tail -n N`; other filters make ranges unknown.
    let narrowed: PlannedRead[] = reads;
    for (const stage of pipeline.slice(1)) {
      const w = stripWrappers(stage.words);
      narrowed = narrow(narrowed, w);
    }
    planned.push(...narrowed);
  }

  if (planned.length === 0 && grepPipeline) {
    return attributeGrepLines(stdout, { ...ctx, cwd }, grepPipeline.searchAbs, "Bash");
  }
  if (planned.length === 0) return [];
  const totalWeight = planned.reduce((s, p) => s + Math.max(1, p.weight), 0);
  return planned.map((p) => {
    const share = planned.length === 1 ? stdout.length : Math.round((stdout.length * Math.max(1, p.weight)) / totalWeight);
    return rec(ctx, "Bash", p.file, share, {
      ...(p.ranges ? { ranges: p.ranges } : {}),
      totalLines: p.totalLines,
    });
  });
}

/** Drops wrappers like `rtk proxy`, `command`, `sudo`; maps `rtk read` to cat. */
function stripWrappers(words: string[]): string[] {
  let w = [...words];
  for (;;) {
    if (w[0] === "command" || w[0] === "builtin" || w[0] === "sudo" || w[0] === "nice") w = w.slice(1);
    else if (w[0] === "rtk" && w[1] === "proxy") w = w.slice(2);
    else if (w[0] === "rtk" && (w[1] === "read" || w[1] === "cat")) w = ["cat", ...w.slice(2)];
    else break;
  }
  return w;
}

function fileInfo(path: string, cwd: string): { abs: string; lines: number } | undefined {
  const abs = resolve(cwd, path);
  if (!isFile(abs)) return undefined;
  return { abs, lines: countLines(readTextOr(abs, "")) };
}

function planReader(words: string[], cwd: string): PlannedRead[] | "grep" | undefined {
  const cmd = words[0];
  if (!cmd) return undefined;
  const base = cmd.split("/").pop()!;
  if (WHOLE_FILE_READERS.has(base)) {
    const files = words.slice(1).filter((w) => !w.startsWith("-"));
    const out: PlannedRead[] = [];
    for (const f of files) {
      const info = fileInfo(f, cwd);
      if (info) out.push({ file: info.abs, ranges: info.lines ? [[1, info.lines]] : [], totalLines: info.lines, weight: info.lines });
    }
    return out.length ? out : undefined;
  }
  if (base === "head" || base === "tail") {
    let n = 10;
    let fromStart: number | undefined;
    const files: string[] = [];
    for (let k = 1; k < words.length; k++) {
      const w = words[k];
      if (w === "-n" || w === "--lines") {
        const v = words[++k] ?? "";
        if (v.startsWith("+")) fromStart = Number(v.slice(1));
        else n = Number(v);
      } else if (/^-n\+?\d+$/.test(w)) {
        const v = w.slice(2);
        if (v.startsWith("+")) fromStart = Number(v.slice(1));
        else n = Number(v);
      } else if (/^--lines=\+?\d+$/.test(w)) {
        const v = w.slice(8);
        if (v.startsWith("+")) fromStart = Number(v.slice(1));
        else n = Number(v);
      } else if (/^-\d+$/.test(w)) {
        n = Number(w.slice(1));
      } else if (w === "-c" || w === "--bytes") {
        return undefined; // byte counts: no line ranges
      } else if (!w.startsWith("-")) {
        files.push(w);
      }
    }
    if (!Number.isFinite(n)) return undefined;
    const out: PlannedRead[] = [];
    for (const f of files) {
      const info = fileInfo(f, cwd);
      if (!info) continue;
      const total = info.lines;
      let range: Range;
      if (base === "head") range = [1, Math.min(n, total)];
      else if (fromStart !== undefined) range = [Math.max(1, fromStart), total];
      else range = [Math.max(1, total - n + 1), total];
      out.push({ file: info.abs, ranges: total ? [range] : [], totalLines: total, weight: range[1] - range[0] + 1 });
    }
    return out.length ? out : undefined;
  }
  if (base === "sed") {
    const script = words.find((w, k) => k > 0 && /^\d+(,(\d+|\$))?p$/.test(w));
    const quiet = words.includes("-n");
    const files = words.slice(1).filter((w) => !w.startsWith("-") && w !== script);
    if (!script || !quiet || files.length !== 1) return undefined;
    const info = fileInfo(files[0], cwd);
    if (!info) return undefined;
    const m = /^(\d+)(?:,(\d+|\$))?p$/.exec(script)!;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : m[2] === "$" ? info.lines : Number(m[2]);
    const range: Range = [a, Math.min(b, info.lines)];
    return [{ file: info.abs, ranges: range[1] >= range[0] ? [range] : [], totalLines: info.lines, weight: range[1] - range[0] + 1 }];
  }
  if (base === "grep" || base === "rg" || base === "egrep") return "grep";
  return undefined;
}

/** The single file or folder a grep/rg command searches, if it names exactly one. */
function grepTarget(words: string[], cwd: string): string | undefined {
  const positional: string[] = [];
  const takesValue = new Set(["-e", "-f", "-m", "-A", "-B", "-C", "-g", "--glob", "-t", "--type", "--max-count"]);
  for (let k = 1; k < words.length; k++) {
    const w = words[k];
    if (takesValue.has(w)) {
      k++;
      continue;
    }
    if (w.startsWith("-")) continue;
    positional.push(w);
  }
  // First positional is the pattern (unless -e was used; close enough), the rest are paths.
  const paths = positional.slice(1);
  if (paths.length !== 1) return undefined;
  const abs = resolve(cwd, paths[0]);
  return abs;
}

function narrow(reads: PlannedRead[], stage: string[]): PlannedRead[] {
  const cmd = stage[0]?.split("/").pop();
  if (reads.length !== 1) return reads.map((r) => ({ ...r, ranges: undefined }));
  const r = reads[0];
  if (cmd === "cat" && stage.length === 1) return reads;
  if ((cmd === "head" || cmd === "tail") && r.ranges && r.ranges.length === 1) {
    let n = 10;
    for (let k = 1; k < stage.length; k++) {
      const w = stage[k];
      if (w === "-n") n = Number(stage[++k]);
      else if (/^-n\d+$/.test(w)) n = Number(w.slice(2));
      else if (/^-\d+$/.test(w)) n = Number(w.slice(1));
    }
    if (!Number.isFinite(n)) return [{ ...r, ranges: undefined }];
    const [a, b] = r.ranges[0];
    const range: Range = cmd === "head" ? [a, Math.min(b, a + n - 1)] : [Math.max(a, b - n + 1), b];
    return [{ ...r, ranges: [range], weight: range[1] - range[0] + 1 }];
  }
  return [{ ...r, ranges: undefined }];
}

// ---------- Instructions (CLAUDE.md, rules files) ----------

export function extractInstructions(input: HookInput, root: string, charsPerToken = 4, now?: Date): ReadRecord[] {
  const ctx = ctxFrom(input, root, charsPerToken, now);
  const path = input.file_path;
  if (!path) return [];
  const text = readTextOr(path, "");
  const lines = countLines(text);
  return [
    rec(ctx, "Instructions", path, text.length, {
      ranges: lines ? [[1, lines]] : [],
      totalLines: lines,
      loadReason: input.load_reason,
      ...(input.trigger_file_path ? { trigger: relToRoot(root, input.trigger_file_path) } : {}),
    }),
  ];
}
