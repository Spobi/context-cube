import { join } from "node:path";
import { readTextOr, exists, isDir, readJson } from "../fsutil";
import { allBoxes, getBox, getRow, loadCube, type Cube } from "../cube";
import { ConfigSchema, loadConfig, type CubeConfig } from "../config";
import { splitGenerated } from "../format/generated";
import { findInlineRefs } from "../format/links";
import { idKey, parseId } from "../format/ids";
import { loadAliases, loadRetired } from "../state/state";
import { editedGenerated } from "../index/backlinks";
import { cubeMd, rowPages } from "../index/pages";
import { estimateTokens, fmtInt } from "../tokens";
import { listProposals, unapprovedChanges } from "../approvals";
import { TOOL_COMMAND } from "../paths";
import { alwaysLoadedBlock, ruleText } from "../index/index";
import { archiveIssues } from "../archive";

export interface Issue {
  level: "error" | "warn";
  code: string;
  id?: string;
  message: string;
  fix?: string;
}

export type CheckFn = (ctx: CheckContext) => Issue[] | Promise<Issue[]>;

export interface CheckContext {
  root: string;
  cube: Cube;
  config: CubeConfig;
}

const extraChecks: { name: string; fn: CheckFn }[] = [];

/** Later phases add checks (approvals, coverage, staleness) here. */
export function registerCheck(name: string, fn: CheckFn): void {
  if (!extraChecks.some((c) => c.name === name)) extraChecks.push({ name, fn });
}

export async function runChecks(root: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  let config: CubeConfig;
  const cfgPath = join(root, "context-cube", "cube.config.json");
  try {
    config = loadConfig(root);
  } catch (err) {
    issues.push({ level: "error", code: "config-invalid", message: `cube.config.json is invalid: ${(err as Error).message.split("\n")[0]}`, fix: "Fix it with `cube config set`, or restore it from git." });
    config = ConfigSchema.parse({});
  }
  if (exists(cfgPath)) {
    try {
      readJson(cfgPath);
    } catch {
      issues.push({ level: "error", code: "config-invalid", message: "cube.config.json is not valid JSON." });
    }
  }
  const cube = loadCube(root);
  const ctx: CheckContext = { root, cube, config };
  issues.push(...structureChecks(ctx));
  issues.push(...archiveChecks(root));
  for (const c of extraChecks) {
    try {
      issues.push(...(await c.fn(ctx)));
    } catch (err) {
      issues.push({ level: "warn", code: "check-crashed", message: `The ${c.name} check failed to run: ${(err as Error).message}` });
    }
  }
  return issues;
}

export function structureChecks({ root, cube, config }: CheckContext): Issue[] {
  const issues: Issue[] = [];
  const err = (code: string, message: string, id?: string, fix?: string) => issues.push({ level: "error", code, id, message, fix });
  const warn = (code: string, message: string, id?: string, fix?: string) => issues.push({ level: "warn", code, id, message, fix });
  const cpt = config.tokens.charsPerToken;

  for (const d of cube.strayDirs) warn("bad-folder-name", `context-cube/${d}/ isn't a row folder (rows look like Y05-some-name).`, undefined, "Rename or remove it.");

  const rowNums = new Map<number, string[]>();
  for (const r of cube.allRows) rowNums.set(r.num, [...(rowNums.get(r.num) ?? []), r.relDir]);
  for (const [num, dirs] of rowNums) {
    if (dirs.length > 1) err("duplicate-coordinate", `Row number ${String(num).padStart(2, "0")} is used by ${dirs.join(" and ")}.`, `Y${String(num).padStart(2, "0")}`, "Run `cube check --fix` to renumber the newer one.");
  }

  const retired = new Set(loadRetired(root).map((r) => idKey(r.id)));
  const retiredRows = new Set(loadRetired(root).filter((r) => parseId(r.id)?.box === undefined).map((r) => parseId(r.id)!.row));

  for (const row of cube.rows) {
    if (retiredRows.has(row.num)) err("reused-number", `${row.id} was retired and must not be reused (${row.relDir}).`, row.id);
    if (!row.root) err("missing-root", `${row.id} has no root box (X000-root/Z0-overview.md).`, row.id, "Create it with a header that has row_type, summary, and read_when.");
    for (const d of row.strayDirs) warn("bad-folder-name", `${row.relDir}/${d}/ isn't a box folder (boxes look like X003-some-name).`, row.id);
    const nums = new Map<number, string[]>();
    for (const b of row.allBoxes) nums.set(b.num, [...(nums.get(b.num) ?? []), b.relDir]);
    for (const [, dirs] of nums) {
      if (dirs.length > 1) err("duplicate-coordinate", `Two boxes share a number: ${dirs.join(" and ")}.`, undefined, "Run `cube check --fix` to renumber the newer one.");
    }
  }

  for (const box of cube.rows.flatMap((r) => r.allBoxes)) {
    const row = getRow(cube, box.rowNum)!;
    if (!box.isRoot && retired.has(idKey(box.id))) err("reused-number", `${box.id} was retired and must not be reused (${box.relDir}).`, box.id);
    for (const f of box.strayFiles) warn("stray-file", `${box.relDir}/${f} isn't a drawer file (drawers are Z0-overview.md … Z4-detail.md).`, box.id);
    if (!box.drawers.some((d) => d.z === 0)) {
      err("missing-z0", `${box.relDir} has no Z0-overview.md.`, box.id);
      continue;
    }
    if (!box.header) {
      err("header-invalid", `${box.id} header: ${box.doc?.error ?? "invalid"}.`, box.id, `Fix the --- block at the top of ${box.relDir}/Z0-overview.md.`);
      continue;
    }
    const h = box.header;
    const hc = parseId(h.id);
    if (!hc || hc.row !== box.rowNum || hc.box !== box.num || hc.drawer !== undefined) {
      err("id-mismatch", `${box.relDir}: header id is ${h.id}, but the folder says ${box.id}.`, box.id, "The folder is the identity; set the header id to match.");
    } else if (h.id !== box.id) {
      warn("id-format", `${box.relDir}: header id ${h.id} should be written ${box.id}.`, box.id);
    }
    if (h.name !== box.name && !(box.isRoot && h.name === row.name)) {
      warn("name-mismatch", `${box.id}: header name "${h.name}" differs from the folder name "${box.isRoot ? row.name : box.name}".`, box.id, "Use `cube rename` so both stay in sync.");
    }
    if (!h.read_when?.trim()) err("missing-read-when", `${box.id} has no read_when line.`, box.id, "Every Z0 needs a read_when line saying when to open the box.");
    else if (row.type !== "rules") {
      const vague = vagueReadWhen(h.read_when);
      if (vague) warn("vague-read-when", `${box.id} read-when is vague ("${vague}"). It decides whether an agent opens the box, so it should name the changes, files, or symptoms that need it.`, box.id, `${TOOL_COMMAND} edit ${box.id} --read-when "Before changing <what>, or when debugging <symptom>."`);
    }
    // A history entry's links record what it touched (its summary says how); other links are routes an agent may follow.
    const routes = row.type === "history" ? [] : h.links;
    if (routes.length > config.limits.links) {
      warn("too-many-links", `${box.id} has ${routes.length} links (limit ~${config.limits.links}). An agent that follows them all reads far more than the task needs.`, box.id, `Keep the links that answer "why would I follow this?"; remove the rest with ${TOOL_COMMAND} unlink.`);
    }
    for (const l of routes) {
      if (!l.note?.trim()) warn("link-without-note", `${box.id} links to ${l.to} without a note saying why to follow it.`, box.id, `${TOOL_COMMAND} unlink ${box.id} ${l.to}, then link it again with --note "<why follow it>".`);
    }
    if (!h.summary.trim()) err("missing-summary", `${box.id} has an empty summary.`, box.id);
    if (box.isRoot && !h.row_type) warn("missing-row-type", `${row.id}'s root has no row_type.`, box.id);

    for (const l of h.links) {
      const lc = parseId(l.to);
      const target = lc?.box !== undefined ? getBox(cube, l.to) : lc ? getRow(cube, lc.row)?.root : undefined;
      if (!lc || !target) {
        err("broken-link", `${box.id} links to ${l.to}, which doesn't exist.`, box.id, `Run \`cube resolve ${l.to}\`, or remove the link.`);
        continue;
      }
      const targetName = target.isRoot ? getRow(cube, target.rowNum)!.name : target.name;
      if (l.name !== undefined && l.name !== targetName) warn("stale-link-name", `${box.id} calls ${l.to} "${l.name}", but it's now "${targetName}".`, box.id, "Run `cube index` to sync link names.");
    }

    const own = splitGenerated(box.doc!.body).own;
    const words = `${h.summary} ${own}`.split(/\s+/).filter(Boolean).length;
    if (words > config.limits.z0Words && h.written_by !== "migrated" && !box.isRoot) {
      warn("z0-too-long", `${box.id} Z0 is ${words} words (limit ~${config.limits.z0Words}).`, box.id, "Move detail into Z4.");
    }
    for (const d of box.drawers) {
      const text = readTextOr(d.path, "");
      const body = d.z === 0 ? own : splitGenerated(text).own;
      for (const ref of findInlineRefs(body)) {
        const rc = parseId(ref)!;
        const ok = rc.box === undefined ? !!getRow(cube, rc.row) : !!getBox(cube, ref);
        if (!ok) err("broken-ref", `${box.id}.Z${d.z} refers to [[${ref}]], which doesn't exist.`, box.id, `Run \`cube resolve ${ref}\`.`);
      }
      if (box.isRoot && d.z !== 0) {
        const t = estimateTokens(d.chars, cpt);
        if (t > config.limits.rootDrawerTokens) warn("root-drawer-too-large", `${box.id}.Z${d.z} is ~${fmtInt(t)} tokens (limit ~${fmtInt(config.limits.rootDrawerTokens)}).`, box.id, "Roots state row-wide things once and link to boxes for the rest.");
      }
    }
    if (box.isRoot) {
      const t = estimateTokens(box.drawers.find((d) => d.z === 0)!.chars, cpt);
      if (t > config.limits.rootDrawerTokens) warn("root-drawer-too-large", `${box.id}.Z0 is ~${fmtInt(t)} tokens (limit ~${fmtInt(config.limits.rootDrawerTokens)}).`, box.id);
    }
  }

  for (const e of editedGenerated(cube)) {
    err("generated-edited", `${e.id}: the generated section (between the cube:generated markers) was edited.`, e.id, "Put your text above the markers; `cube index` rewrites the generated part.");
  }

  for (const a of loadAliases(root)) {
    const c = parseId(a.target);
    const ok = c && (c.box === undefined ? !!getRow(cube, c.row) : !!getBox(cube, a.target));
    if (!ok) warn("broken-alias", `Alias "${a.alias}" points to ${a.target}, which doesn't exist.`);
  }

  for (const u of unapprovedChanges(root)) {
    err("unapproved-invariant-change", `${u.id} ${u.name}: its invariant text changed without approval.`, u.id, `Undo the edit, or propose it: ${TOOL_COMMAND} propose edit ${u.id} --text @<file> --reason "..."`);
  }
  for (const p of listProposals(root)) {
    warn("pending-approval", `${p.id}: a proposed ${p.kind} of ${p.box} ${p.name} is waiting for a person's approval${p.weakens ? " (it weakens or removes a rule)" : ""}.`, p.box, `See it with: ${TOOL_COMMAND} pending`);
  }

  if (cube.rows.length) issues.push(...blockChecks(root, cube, config));

  if (cube.rows.length) {
    let outdated = readTextOr(cube.paths.cubeMd, "") !== cubeMd(cube, config);
    for (const row of cube.rows) {
      for (const p of rowPages(row, config)) if (readTextOr(join(row.dir, p.file), "") !== p.text) outdated = true;
    }
    if (outdated) warn("index-outdated", "CUBE.md or a row index is out of date.", undefined, "Run `cube index`.");
  }
  return issues;
}

const VAGUE_CLAUSE = /^(?:when\s+)?(?:understanding|learning(?:\s+about)?|working\s+(?:on|with|in)|dealing\s+with|anything\s+(?:about|related|to\s+do\s+with)|questions?\s+about|general|getting\s+familiar|exploring|context\s+(?:on|about|for))\b/i;

/** A read-when clause that names a topic instead of a change or a symptom, if any. */
export function vagueReadWhen(text: string): string | undefined {
  const t = text.trim().replace(/\.$/, "");
  if (t.split(/\s+/).length < 4 && !/^always\b/i.test(t)) return t;
  for (const clause of t.split(/[,;]|\s+or\s+/)) {
    const c = clause.trim().replace(/^(?:and|or)\s+/i, "");
    if (VAGUE_CLAUSE.test(c)) return c.replace(/[.]$/, "");
  }
  return undefined;
}

/** Folders and files a rule's text names that exist in the project: candidates for --paths. */
function namedPaths(root: string, text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]*)/g)) {
    const p = m[1].replace(/[.,;:]+$/, "").replace(/\/+$/, "");
    if (!p || p.startsWith("context-cube") || !exists(join(root, p))) continue;
    out.add(isDir(join(root, p)) ? `${p}/**` : p);
  }
  return [...out];
}

/**
 * The always-loaded block is read at the start of every session, so it has a
 * ceiling (limits.blockTokens). Above it the row list is shortened; if it's
 * still over, universal rules should stay and file-specific ones should load
 * with their files.
 */
function blockChecks(root: string, cube: Cube, config: CubeConfig): Issue[] {
  const cpt = config.tokens.charsPerToken;
  const limit = config.limits.blockTokens;
  const tokens = estimateTokens(alwaysLoadedBlock(cube, config).length, cpt);
  const rules = ruleText(cube).filter((r) => !r.paths);
  const ruleTokens = estimateTokens(rules.reduce((n, r) => n + r.text.length + 12, 0), cpt);
  const suggest = rules
    .map((r) => ({ id: r.id, paths: namedPaths(root, r.text) }))
    .filter((r) => r.paths.length)
    .slice(0, 5)
    .map((r) => `${TOOL_COMMAND} edit ${r.id} --paths "${r.paths.join(",")}"`);
  const fix = suggest.length
    ? `Rules that are only about certain files can load with those files instead. Only do it for a rule that can't matter elsewhere (a rule about where new files go must stay). Candidates: ${suggest.join(" ; ")}`
    : "Keep only rules that apply to every task in the rules row; scope file-specific ones with `cube edit <id> --paths`, or merge small rows.";
  if (tokens > limit) {
    return [{ level: "warn", code: "block-too-large", message: `The always-loaded block is ~${fmtInt(tokens)} tokens, over its ceiling of ~${fmtInt(limit)} even with the row list shortened (rules ~${fmtInt(ruleTokens)}, ${rules.length} of them). It is read at the start of every session.`, fix }];
  }
  const full = unshortenedBlockTokens(cube, config);
  if (full > limit) {
    return [{ level: "warn", code: "block-shortened", message: `The always-loaded block's row list was shortened to fit its ceiling of ~${fmtInt(limit)} tokens (it would be ~${fmtInt(full)}): rows show only when to open them.`, fix }];
  }
  return [];
}

function unshortenedBlockTokens(cube: Cube, config: CubeConfig): number {
  return estimateTokens(alwaysLoadedBlock(cube, { ...config, limits: { ...config.limits, blockTokens: Number.MAX_SAFE_INTEGER } }).length, config.tokens.charsPerToken);
}

/** Archived source files with text added since, and placeholders whose original is gone. */
function archiveChecks(root: string): Issue[] {
  return archiveIssues(root).map((a) =>
    a.kind === "added"
      ? {
          level: "warn" as const,
          code: "archived-file-changed",
          message: `${a.path} was archived, but ${a.lines} line${a.lines === 1 ? " was" : "s were"} added to it since. That text isn't in the cube.`,
          fix: `Move it into the cube (a rule: ${TOOL_COMMAND} new-box Y00 …; a change: ${TOOL_COMMAND} history add …), then delete it from ${a.path}, leaving the placeholder.`,
        }
      : {
          level: "warn" as const,
          code: "archive-missing",
          message: `${a.path} is an archive placeholder, but its original isn't in context-cube/.state/archive/.`,
          fix: `Get the original back from git history (git log -- context-cube/.state/archive/${a.path}), then put it at context-cube/.state/archive/${a.path}.`,
        },
  );
}

export function renderIssues(issues: Issue[], opts: { group?: number } = {}): string {
  const errors = issues.filter((i) => i.level === "error");
  const warns = issues.filter((i) => i.level === "warn");
  const out: string[] = [];
  const max = opts.group ?? 3;
  const shown = new Map<string, number>();
  const hidden = new Map<string, number>();
  for (const i of [...errors, ...warns]) {
    const n = shown.get(i.code) ?? 0;
    if (n >= max) {
      hidden.set(i.code, (hidden.get(i.code) ?? 0) + 1);
      continue;
    }
    shown.set(i.code, n + 1);
    out.push(`${i.level === "error" ? "error" : "warn "}  [${i.code}] ${i.message}`);
    if (i.fix && n === 0) out.push(`       → ${i.fix}`);
  }
  for (const [code, n] of hidden) out.push(`       …and ${n} more [${code}] (see all with: cube check --json)`);
  out.push(`cube check: ${errors.length} error${errors.length === 1 ? "" : "s"}, ${warns.length} warning${warns.length === 1 ? "" : "s"}.`);
  return out.join("\n");
}
