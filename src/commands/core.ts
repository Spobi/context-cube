import { join, relative } from "node:path";
import { exists, readText, readTextOr, writeText } from "../core/fsutil";
import { cubePaths, findProjectRoot, TOOL_COMMAND } from "../core/paths";
import { installTool, writeSearchIgnore } from "../core/tool";
import { defaultConfig, getSetting, loadConfig, parseSettingValue, saveConfig, setSetting, SETTING_KEYS, type CubeConfig } from "../core/config";
import { allBoxes, getBox, getRow, loadCube } from "../core/cube";
import { addLink, bulkUpdateHeaders, createBox, createRow, CubeError, deleteBox, ensureNl, moveBox, removeLink, renameBox, renameRow } from "../core/ops";
import { alwaysLoadedBlock, reindex } from "../core/index/index";
import { estimateTokens, fmtInt } from "../core/tokens";
import { renderIssues, runChecks } from "../core/check/check";
import { historyRoot, invariantsRoot, rulesRoot } from "../core/templates";
import { LINK_RELS, ROW_TYPES, type LinkRel, type RowType, type Writer } from "../core/format/drawers";
import type { Link } from "../core/format/header";
import { isId, parseId } from "../core/format/ids";
import { loadAliases, resolveAlias } from "../core/state/state";
import { ADAPTERS } from "../adapters/registry";
import { fixDuplicates } from "../core/check/fix";
import { proposeNew, unapprovedChanges } from "../core/approvals";
import { GITATTRIBUTES } from "../core/merge";
import { find, related, renderFind, renderRelated } from "../core/related";
import { deleteRecordBox, isRecordBox } from "../core/records";

export function rootFor(cwd?: string): string {
  return findProjectRoot(cwd);
}

function requireCube(root: string): void {
  if (!exists(cubePaths(root).cube) || !loadCube(root).rows.length) {
    throw new CubeError(`No cube here (${root}). Create one with \`npx context-cube\` or \`cube init\`.`);
  }
}

// ---------- init ----------

export interface InitOptions {
  cwd?: string;
  agents?: string[];
  historyUnit?: CubeConfig["history"]["unit"];
}

/** Creates an empty cube: the rules, history, and invariants rows (plan 6, fresh project). */
export async function init(opts: InitOptions = {}): Promise<string[]> {
  const root = rootFor(opts.cwd);
  const p = cubePaths(root);
  if (loadCube(root).rows.length) {
    return [`A cube already exists in ${relative(process.cwd(), p.cube) || p.cube}. Nothing changed.`];
  }
  installTool(root);
  const config = exists(p.config) ? loadConfig(root) : defaultConfig();
  if (opts.agents?.length) config.agents = [...new Set([...config.agents, ...opts.agents])];
  if (!config.agents.length) config.agents = ["claude-code"];
  if (opts.historyUnit) config.history.unit = opts.historyUnit;
  saveConfig(root, config);
  writeStateScaffold(root);
  createRow(root, rulesRoot());
  createRow(root, historyRoot(config.history.unit));
  createRow(root, invariantsRoot());
  await reindex(root);
  return [
    `Created a cube in ${p.cube}`,
    "  Y00 rules, Y01 history, Y02 invariants",
    `  The always-loaded block is in ${config.agents.map((a) => (a === "generic" ? "AGENTS.md" : "CLAUDE.md")).join(" and ")}.`,
    "",
    `Add a rule:   ${TOOL_COMMAND} new-box Y00 "short-name" --summary "The rule, in one line." --read-when "Always."`,
    `See the rows: context-cube/CUBE.md`,
  ];
}

export function writeStateScaffold(root: string): void {
  const p = cubePaths(root);
  const gitattributes = join(p.cube, ".gitattributes");
  if (!exists(gitattributes)) writeText(gitattributes, GITATTRIBUTES);
  const gitignore = join(p.cube, ".gitignore");
  if (!exists(gitignore)) writeText(gitignore, ".logs/\n");
  writeSearchIgnore(root);
  if (!exists(p.retired)) writeText(p.retired, "# Numbers used and deleted. Never reused. id<TAB>date<TAB>reason\n");
  if (!exists(p.aliases)) writeText(p.aliases, "# Legacy references and old coordinates → current coordinates. alias<TAB>target\n");
}

// ---------- rows and boxes ----------

export interface NewRowOptions {
  type: string;
  summary: string;
  readWhen: string;
  convention?: string[];
  body?: string;
  cwd?: string;
  index?: boolean;
}

export async function newRow(name: string, opts: NewRowOptions): Promise<string[]> {
  const root = rootFor(opts.cwd);
  requireCube(root);
  if (!(ROW_TYPES as readonly string[]).includes(opts.type)) throw new CubeError(`Unknown row type "${opts.type}". Types: ${ROW_TYPES.join(", ")}`);
  const row = createRow(root, {
    type: opts.type as RowType,
    name,
    summary: opts.summary,
    readWhen: opts.readWhen,
    conventions: opts.convention,
    body: readBody(opts.body),
  });
  if (opts.index !== false) await reindex(root);
  return [`Created ${row.id} ${row.name} (context-cube/${row.relDir}/)`];
}

export interface NewBoxOptions {
  summary: string;
  readWhen?: string;
  body?: string;
  z1?: string;
  z2?: string;
  z3?: string;
  z4?: string;
  link?: string[];
  status?: string;
  source?: string;
  writtenBy?: string;
  reason?: string;
  cwd?: string;
  index?: boolean;
}

/** Reads `@path` or `-` (stdin text passed in by the caller) or plain text. */
export function readBody(value: string | undefined, stdin?: string): string | undefined {
  if (value === undefined) return undefined;
  if (value === "-") return stdin ?? "";
  if (value.startsWith("@")) return readText(value.slice(1));
  return value.replace(/\\n/g, "\n");
}

function nl(s: string | undefined): string | undefined {
  return s === undefined || s === "" ? s : ensureNl(s);
}

export function parseLinkSpec(spec: string): Link {
  // Y02.X007[:rel[:note]]
  const [to, rel = "see-also", ...note] = spec.split(":");
  if (!isId(to)) throw new CubeError(`"${to}" isn't a coordinate like Y02.X007.`);
  if (!(LINK_RELS as readonly string[]).includes(rel)) throw new CubeError(`Unknown link type "${rel}". Types: ${LINK_RELS.join(", ")}`);
  return { to, rel: rel as LinkRel, note: note.length ? note.join(":") : undefined };
}

export async function newBox(rowRef: string, name: string, opts: NewBoxOptions, stdin?: string): Promise<string[]> {
  const root = rootFor(opts.cwd);
  requireCube(root);
  const cube = loadCube(root);
  const row = getRow(cube, rowRef);
  if (!row) throw new CubeError(`No row ${rowRef}. See the row list in context-cube/CUBE.md.`);
  if (row.type === "invariants") {
    // New invariants go in immediately but start as pending (plan 9.1), through the approval log.
    if (!opts.z1) throw new CubeError(`A box in the invariants row needs its text: --z1 @<file>. (Or use ${TOOL_COMMAND} propose new.)`);
    if (!opts.reason) throw new CubeError('Say why with --reason "...": new invariants go in the approvals log.');
    const res = proposeNew(root, { name, summary: opts.summary, readWhen: opts.readWhen ?? "", text: readBody(opts.z1, stdin) ?? "", reason: opts.reason });
    if (opts.index !== false) await reindex(root);
    return [`Created ${res.proposal.box} ${res.proposal.name}${res.applied ? "" : ` (pending until a person approves it: ${TOOL_COMMAND} approve ${res.proposal.id})`}`];
  }
  const body = readBody(opts.body, stdin);
  if (row.type === "rules") {
    // The rules load at the start of every session, so their ceiling is a hard stop: a person raises it.
    const config = loadConfig(root);
    const cpt = config.tokens.charsPerToken;
    const now = estimateTokens(alwaysLoadedBlock(cube, config).length, cpt);
    const adding = estimateTokens((body || opts.summary || name).length + 20, cpt);
    if (now + adding > config.limits.blockTokens) {
      throw new CubeError(
        `A new rule would make the block that loads at the start of every session ~${fmtInt(now + adding)} tokens, over its ceiling of ~${fmtInt(config.limits.blockTokens)}. ` +
          `If it's about one area, put it in that area's row instead (${TOOL_COMMAND} new-box <row> ...). If it's only about certain files, add it and scope it right away (${TOOL_COMMAND} edit <id> --paths "<globs>"), after making room. ` +
          `A person can raise the ceiling: ${TOOL_COMMAND} config set limits.blockTokens <tokens>.`,
      );
    }
  }
  const box = createBox(root, row.num, {
    name,
    summary: opts.summary,
    readWhen: opts.readWhen,
    body,
    drawers: {
      1: nl(readBody(opts.z1, stdin)),
      2: nl(readBody(opts.z2, stdin)),
      3: nl(readBody(opts.z3, stdin)),
      4: nl(readBody(opts.z4, stdin)),
    },
    links: (opts.link ?? []).map(parseLinkSpec),
    status: opts.status as any,
    source: opts.source,
    writtenBy: (opts.writtenBy as Writer) ?? "person",
  });
  if (opts.index !== false) await reindex(root);
  const lines = [`Created ${box.id} ${box.name} (context-cube/${box.relDir}/)`];
  if (box.header?.status === "pending") lines.push("It's marked pending until a person approves it: cube approve " + box.id);
  return lines;
}

export async function link(from: string, to: string, opts: { rel?: string; note?: string; cwd?: string }): Promise<string[]> {
  const root = rootFor(opts.cwd);
  requireCube(root);
  const rel = (opts.rel ?? "see-also") as LinkRel;
  if (!(LINK_RELS as readonly string[]).includes(rel)) throw new CubeError(`Unknown link type "${rel}". Types: ${LINK_RELS.join(", ")}`);
  const l = addLink(root, from, to, rel, opts.note);
  await reindex(root);
  return [`Linked ${from} → ${l.to} (${l.rel})${l.note ? `: ${l.note}` : ""}`];
}

export async function unlink(from: string, to: string, opts: { rel?: string; cwd?: string }): Promise<string[]> {
  const root = rootFor(opts.cwd);
  requireCube(root);
  const n = removeLink(root, from, to, opts.rel as LinkRel | undefined);
  await reindex(root);
  return [n ? `Removed ${n} link${n === 1 ? "" : "s"} from ${from} to ${to}.` : `${from} had no link to ${to}.`];
}

export async function move(id: string, toRow: string, opts: { readWhen?: string; cwd?: string }): Promise<string[]> {
  const root = rootFor(opts.cwd);
  requireCube(root);
  const before = loadCube(root);
  const box = getBox(before, id);
  const dest = getRow(before, toRow.split(".")[0]);
  // A rule's read-when is "Always."; in any other row that would send agents to the box on every task.
  if (box && dest && dest.type !== "rules" && !opts.readWhen?.trim() && /^always\.?$/i.test(box.header?.read_when?.trim() ?? "")) {
    throw new CubeError(`${box.id}'s read-when line is "Always.", which in ${dest.id} would send agents to it on every task. Say when a task needs it: ${TOOL_COMMAND} move ${box.id} ${toRow} --read-when "Before changing <what>, or when <situation>."`);
  }
  const r = moveBox(root, id, toRow);
  if (opts.readWhen?.trim()) bulkUpdateHeaders(root, new Map([[r.to, { readWhen: opts.readWhen.trim() }]]));
  await reindex(root);
  return [`Moved ${r.from} → ${r.to}. Links were rewritten, and "${r.from}" now resolves to ${r.to}.${opts.readWhen?.trim() ? " Its read-when line is updated." : ""}`];
}

export async function rename(id: string, newName: string, opts: { cwd?: string }): Promise<string[]> {
  const root = rootFor(opts.cwd);
  requireCube(root);
  const c = parseId(id);
  if (c && c.box === undefined) {
    const row = renameRow(root, id, newName);
    await reindex(root);
    return [`Renamed ${row.id} to ${row.name}.`];
  }
  const box = renameBox(root, id, newName);
  await reindex(root);
  return [`Renamed ${box.id} to ${box.name}.`];
}

export async function remove(id: string, opts: { reason?: string; cwd?: string }): Promise<string[]> {
  const root = rootFor(opts.cwd);
  requireCube(root);
  const cube = loadCube(root);
  const box = getBox(cube, id);
  if (box && getRow(cube, box.rowNum)?.type === "invariants" && loadConfig(root).invariants.approval === "required") {
    throw new CubeError(`${box.id} is an invariant. Deleting one needs a person's approval: ${TOOL_COMMAND} propose delete ${box.id} --reason "..."`);
  }
  if (box && isRecordBox(root, cube, box)) {
    if (!opts.reason?.trim()) {
      throw new CubeError(`${box.id} holds a record: text moved word for word from the original files, or a closed history entry. Deleting it takes it out of what agents can find, so a person decides, and says why: ${TOOL_COMMAND} delete ${box.id} --reason "<why>". If it's only out of date, add what changed instead: ${TOOL_COMMAND} write ${box.id} Z4 --append @<file>`);
    }
    const { id: gone, kept } = deleteRecordBox(root, box.id, opts.reason);
    await reindex(root);
    return [`Deleted ${gone}. Its number is retired and won't be reused. Logged in context-cube/.state/approvals.log. A copy of its folder is kept in ${kept}/ (in the archive, which Claude doesn't read); a person can bring its text back from there.`];
  }
  const gone = deleteBox(root, id, opts.reason ?? "deleted");
  await reindex(root);
  return [`Deleted ${gone}. Its number is retired and won't be reused.`];
}

// ---------- index, check, resolve ----------

export async function index(opts: { cwd?: string }): Promise<string[]> {
  const root = rootFor(opts.cwd);
  requireCube(root);
  const r = await reindex(root);
  return [`Indexed ${r.rows} rows and ${r.boxes} boxes (${r.filesChanged} file${r.filesChanged === 1 ? "" : "s"} changed).`];
}

export async function check(opts: { cwd?: string; json?: boolean; fix?: boolean; invariants?: boolean }): Promise<{ text: string; errors: number }> {
  const root = rootFor(opts.cwd);
  if (opts.invariants) {
    if (!loadCube(root).rows.length) return { text: "", errors: 0 };
    const bad = unapprovedChanges(root);
    if (!bad.length) return { text: "", errors: 0 };
    return {
      text: [
        "Context Cube: invariant text changed without approval:",
        ...bad.map((b) => `  ${b.id} ${b.name}`),
        `Undo the edit (git checkout -- <file>), or propose it so a person can approve it: ${TOOL_COMMAND} propose edit <id> --text @<file> --reason "..."`,
      ].join("\n"),
      errors: bad.length,
    };
  }
  requireCube(root);
  const fixed: string[] = [];
  if (opts.fix) {
    fixed.push(...fixDuplicates(root));
    await reindex(root);
  }
  const issues = await runChecks(root);
  const errors = issues.filter((i) => i.level === "error").length;
  if (opts.json) return { text: JSON.stringify({ fixed, issues }, null, 2), errors };
  const text = [...fixed.map((f) => `fixed  ${f}`), renderIssues(issues)].join("\n");
  return { text, errors };
}

/** What the cube holds about a file, folder, or code name (deterministic; no AI). */
export function relatedCmd(query: string, opts: { cwd?: string; json?: boolean }): string {
  const root = rootFor(opts.cwd);
  requireCube(root);
  const r = related(root, query, opts.cwd ?? process.cwd());
  return opts.json ? JSON.stringify(r, null, 2) : renderRelated(r);
}

/** Searches the cube's own text (generated sections and bookkeeping excluded). */
export function findCmd(words: string[], opts: { cwd?: string; json?: boolean }): string {
  const root = rootFor(opts.cwd);
  requireCube(root);
  const query = words.join(" ");
  const hits = find(root, query);
  return opts.json ? JSON.stringify(hits, null, 2) : renderFind(query, hits);
}

export function resolve(ref: string, opts: { cwd?: string }): string[] {
  const root = rootFor(opts.cwd);
  requireCube(root);
  const cube = loadCube(root);
  const show = (id: string, how: string) => {
    const box = getBox(cube, id);
    const row = getRow(cube, id);
    const c = parseId(id)!;
    if (c.box === undefined && row) return `${row.id} ${row.name} → context-cube/${row.relDir}/ROW.md${how}`;
    if (!box) return undefined;
    const file = c.drawer !== undefined ? `/Z${c.drawer}-${["overview", "invariants", "code", "history", "detail"][c.drawer]}.md` : "/";
    return `${box.id}${c.drawer !== undefined ? `.Z${c.drawer}` : ""} ${box.name} → context-cube/${box.relDir}${file}${how}`;
  };
  if (isId(ref)) {
    const direct = show(ref, "");
    if (direct) return [direct];
  }
  const aliased = resolveAlias(loadAliases(root), ref);
  if (aliased) {
    const out = show(aliased, ` (from "${ref}")`);
    if (out) return [out];
    return [`"${ref}" points to ${aliased}, which no longer exists.`];
  }
  const q = ref.toLowerCase();
  const byName = allBoxes(cube).filter((b) => b.name === q || b.name.includes(q) || b.header?.summary.toLowerCase().includes(q));
  if (byName.length) return byName.slice(0, 10).map((b) => show(b.id, "")!).filter(Boolean);
  throw new CubeError(`Nothing matches "${ref}".`);
}

// ---------- config ----------

export function configGet(key: string | undefined, opts: { cwd?: string }): string[] {
  const root = rootFor(opts.cwd);
  const config = loadConfig(root);
  if (!key) return SETTING_KEYS.map((k) => `${k} = ${JSON.stringify(getSetting(config, k))}`);
  if (!(SETTING_KEYS as readonly string[]).includes(key)) throw new CubeError(`Unknown setting "${key}". Settings: ${SETTING_KEYS.join(", ")}`);
  return [JSON.stringify(getSetting(config, key))];
}

export function configSet(key: string, value: string, opts: { cwd?: string }): string[] {
  const root = rootFor(opts.cwd);
  const p = cubePaths(root);
  const config = exists(p.config) ? loadConfig(root) : defaultConfig();
  const before = getSetting(config, key);
  const next = setSetting(config, key, parseSettingValue(key, value));
  saveConfig(root, next);
  const lines = [`${key}: ${JSON.stringify(before)} → ${JSON.stringify(getSetting(next, key))}`];
  if (key === "invariants.approval" && getSetting(next, key) === "auto") {
    lines.push("Invariant changes now apply without a person's approval. Each one is logged as not reviewed by a person.");
  }
  if (key === "agents") {
    const known = ADAPTERS.map((a) => a.id);
    const unknown = (getSetting(next, key) as string[]).filter((a) => !known.includes(a));
    if (unknown.length) lines.push(`Warning: unknown agents ${unknown.join(", ")}. Known: ${known.join(", ")}`);
  }
  return lines;
}

export function readStdinSync(): string {
  try {
    return readTextOr("/dev/stdin", "");
  } catch {
    return "";
  }
}
