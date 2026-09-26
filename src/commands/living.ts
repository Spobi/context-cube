import { findProjectRoot, TOOL_COMMAND } from "../core/paths";
import { getBox, getRow, loadCube } from "../core/cube";
import { bulkUpdateHeaders, CubeError, updateZ0, writeDrawer } from "../core/ops";
import { reindex } from "../core/index/index";
import { addFragment, closeEntry, listFragments, openEntry, openNew } from "../core/history";
import { approve, listProposals, proposeDelete, proposeEdit, proposeNew, reject, renderProposal, unapprovedChanges } from "../core/approvals";
import { lastCommit, updatePlan } from "../core/update";
import { installAgents, uninstallAgents } from "../core/install";
import { installTool, version } from "../core/tool";
import { appendToDrawer, drawerRecord, recordRefusal, replaceRecord } from "../core/records";
import { readBody, parseLinkSpec } from "./core";
import type { Link } from "../core/format/header";

const root = (cwd?: string) => findProjectRoot(cwd);

// ---------- history ----------

export async function historyAdd(text: string | undefined, opts: { key?: string; touches?: string; by?: string; cwd?: string }, stdin?: string): Promise<string[]> {
  const r = root(opts.cwd);
  const body = readBody(text ?? "-", stdin) ?? "";
  const touches: Link[] = (opts.touches ?? "")
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((id) => ({ ...parseLinkSpec(id.includes(":") ? id : `${id}:touches`) }));
  const res = addFragment(r, body, { key: opts.key, by: opts.by, touches });
  await reindex(r);
  const out = [];
  if (res.closed) out.push(`Closed ${res.closed} (a new ${opts.key ? "key" : "entry"} started).`);
  out.push(`Added a fragment to ${res.box.id} ${res.box.name} (fragments/${res.file}).`);
  return out;
}

export async function historyOpen(opts: { key?: string; name?: string; cwd?: string }): Promise<string[]> {
  const r = root(opts.cwd);
  const box = openNew(r, { key: opts.key, name: opts.name });
  await reindex(r);
  return [`Opened ${box.id} ${box.name}. Add to it with: ${TOOL_COMMAND} history add "<note>"`];
}

export async function historyClose(opts: { summary?: string; readWhen?: string; name?: string; cwd?: string }): Promise<string[]> {
  const r = root(opts.cwd);
  const box = closeEntry(r, { summary: opts.summary, readWhen: opts.readWhen, name: opts.name });
  await reindex(r);
  return [`Closed ${box.id} ${box.name}: its fragments are now its Z4.${opts.summary ? "" : ` Give it a better summary with: ${TOOL_COMMAND} edit ${box.id} --summary "..."`}`];
}

export function historyShow(opts: { cwd?: string }): string[] {
  const cube = loadCube(root(opts.cwd));
  const open = openEntry(cube);
  if (!open) return ["No history entry is open."];
  const frags = listFragments(open);
  return [`Open: ${open.id} ${open.name} (context-cube/${open.relDir}/), ${frags.length} fragment${frags.length === 1 ? "" : "s"}`, ...frags.map((f) => `- ${f.file}: ${f.text.replace(/\s+/g, " ").slice(0, 120)}`)];
}

// ---------- writing drawers and headers ----------

function drawerNum(drawer: string): number {
  const z = Number(/^Z?(\d)$/i.exec(drawer)?.[1] ?? NaN);
  if (!(z >= 0 && z <= 4)) throw new CubeError(`"${drawer}" isn't a drawer. Drawers are Z0–Z4.`);
  return z;
}

export async function write(id: string, drawer: string, text: string | undefined, opts: { append?: boolean; cwd?: string }, stdin?: string): Promise<string[]> {
  const r = root(opts.cwd);
  const z = drawerNum(drawer);
  const cube = loadCube(r);
  const box = getBox(cube, id);
  if (!box) throw new CubeError(`No box ${id}.`);
  if (z === 1 && getRow(cube, box.rowNum)?.type === "invariants") {
    throw new CubeError(`Invariant text can't be written directly. Propose it: ${TOOL_COMMAND} propose edit ${box.id} --text @<file> --reason "<why>"`);
  }
  if (z === 2) throw new CubeError(`Z2 is written by code search. Re-link it with: ${TOOL_COMMAND} links ${box.id}`);
  const body = readBody(text ?? "-", stdin) ?? "";
  if (opts.append) {
    if (z === 0) throw new CubeError(`--append adds to Z1, Z3, or Z4. Z0 is the box's overview: change its summary or read-when line with ${TOOL_COMMAND} edit ${box.id}, and put detail in Z4.`);
    if (box.header?.status === "open") throw new CubeError(`${box.id} is the open history entry. Add to it with: ${TOOL_COMMAND} history add "<note>"`);
    const warning = appendToDrawer(r, box.id, z, body);
    await reindex(r);
    return [`Added to ${box.id}.Z${z}, dated, below what was there.`, ...(warning ? [`Note: ${warning}`] : [])];
  }
  const rec = drawerRecord(r, cube, box, z);
  if (rec) throw new CubeError(recordRefusal(rec));
  const withNl = body === "" || body.endsWith("\n") ? body : `${body}\n`;
  if (z === 0) updateZ0(r, box.id, (h, _old) => ({ header: h, body: withNl }));
  else writeDrawer(r, box.id, z, withNl);
  await reindex(r);
  return [`Wrote ${box.id}.Z${z}.`];
}

/** A person replaces a record on purpose (the guard hook asks them to confirm). */
export async function replace(id: string, drawer: string, text: string | undefined, opts: { reason?: string; cwd?: string }, stdin?: string): Promise<string[]> {
  const r = root(opts.cwd);
  const z = drawerNum(drawer);
  const body = text === undefined ? undefined : readBody(text, stdin) ?? "";
  const { rec, kept } = replaceRecord(r, id, z, body, opts.reason ?? "");
  await reindex(r);
  const what = `${rec.box.id}.Z${z}`;
  if (body === undefined) return [`Recorded ${what}'s current text as a change a person made on purpose. Logged in context-cube/.state/approvals.log.`];
  return [`Replaced ${what}. Logged in context-cube/.state/approvals.log.${kept ? ` The text it held is kept in ${kept} (in the archive, which Claude doesn't read).` : ""}`];
}

export async function edit(id: string, opts: { summary?: string; readWhen?: string; scope?: string; status?: string; paths?: string; cwd?: string }): Promise<string[]> {
  const r = root(opts.cwd);
  const cube = loadCube(r);
  const box = getBox(cube, id);
  if (!box) throw new CubeError(`No box ${id}.`);
  if (opts.status && !["ok", "stale", "needs-review"].includes(opts.status)) throw new CubeError('Status can be set to "ok", "stale", or "needs-review" here. Pending and open are set by the tool.');
  if (opts.status === "ok" && box.header?.status === "pending") throw new CubeError(`${box.id} is a pending invariant; a person approves it with: ${TOOL_COMMAND} approve ${box.id}`);
  const paths = opts.paths === undefined ? undefined : opts.paths.split(",").map((p) => p.trim()).filter(Boolean);
  if (paths && (box.isRoot || getRow(cube, box.rowNum)?.type !== "rules")) throw new CubeError("--paths is for rules: it makes a rule load only with the files it's about.");
  bulkUpdateHeaders(r, new Map([[box.id, { summary: opts.summary, readWhen: opts.readWhen, scope: opts.scope, paths, status: opts.status as any, writtenBy: "person" }]]));
  await reindex(r);
  if (paths) return [paths.length ? `${box.id} now loads only with files matching ${paths.join(", ")} (not every session).` : `${box.id} loads every session again.`];
  return [`Updated ${box.id}'s header.`];
}

// ---------- invariant proposals and approval ----------

export async function propose(kind: string, target: string, opts: { text?: string; reason?: string; summary?: string; readWhen?: string; cwd?: string }, stdin?: string): Promise<string[]> {
  const r = root(opts.cwd);
  const reason = opts.reason ?? "";
  let res;
  if (kind === "edit") {
    if (!opts.text) throw new CubeError("Give the new text with --text @<file> (or --text - to read it from standard input).");
    res = proposeEdit(r, target, readBody(opts.text, stdin) ?? "", reason);
  } else if (kind === "delete") {
    res = proposeDelete(r, target, reason);
  } else if (kind === "new") {
    if (!opts.text || !opts.summary || !opts.readWhen) throw new CubeError('A new invariant needs --summary, --read-when, and --text @<file>.');
    res = proposeNew(r, { name: target, summary: opts.summary, readWhen: opts.readWhen, text: readBody(opts.text, stdin) ?? "", reason });
  } else {
    throw new CubeError(`Propose what? Use: propose edit <id>, propose delete <id>, or propose new <name>.`);
  }
  await reindex(r);
  if (res.applied) return [`Applied ${res.proposal.kind} of ${res.proposal.box} at once (invariant approvals are set to auto). It's logged as not reviewed by a person.`];
  const lines = [renderProposal(res.proposal), ""];
  if (res.proposal.kind === "new") lines.push(`${res.proposal.box} is in the cube now, marked pending, so agents see it.`);
  lines.push(`A person approves it with: ${TOOL_COMMAND} approve ${res.proposal.id}   (or rejects it: ${TOOL_COMMAND} reject ${res.proposal.id} --reason "...")`);
  return lines;
}

export function pending(opts: { cwd?: string }): string[] {
  const r = root(opts.cwd);
  const ps = listProposals(r).sort((a, b) => Number(b.weakens) - Number(a.weakens) || (a.kind === "delete" ? -1 : 0));
  const unapproved = unapprovedChanges(r);
  const out: string[] = [];
  if (!ps.length && !unapproved.length) return ["Nothing is waiting for approval."];
  for (const p of ps) out.push(renderProposal(p), "");
  if (unapproved.length) {
    out.push("Changed without approval (edited outside the tool):");
    for (const u of unapproved) out.push(`  ${u.id} ${u.name}: restore it from git, or propose the change properly.`);
  }
  if (ps.length) out.push(`Approve: ${TOOL_COMMAND} approve <id>   Reject: ${TOOL_COMMAND} reject <id> --reason "..."`);
  return out;
}

export async function approveCmd(ref: string, opts: { reason?: string; cwd?: string }): Promise<string[]> {
  const r = root(opts.cwd);
  const p = approve(r, ref, opts.reason);
  await reindex(r);
  return [`Approved ${p.id}: ${p.kind} of ${p.box} ${p.name}. Logged in context-cube/.state/approvals.log.`, "Commit this approval as its own change so it's easy to see in review."];
}

export async function rejectCmd(ref: string, opts: { reason?: string; cwd?: string }): Promise<string[]> {
  const r = root(opts.cwd);
  const p = reject(r, ref, opts.reason ?? "");
  await reindex(r);
  return [`Rejected ${p.id}: ${p.kind} of ${p.box}.${p.kind === "new" ? ` ${p.box} was removed and its number retired.` : ""} Logged.`];
}

// ---------- updating and installing ----------

export function planCmd(opts: { commit?: string; cwd?: string }): string {
  const r = root(opts.cwd);
  const commit = lastCommit(r, opts.commit ?? "HEAD");
  return updatePlan(r, commit ? { commit } : {});
}

export async function install(opts: { cwd?: string; shared?: boolean }): Promise<string[]> {
  const r = root(opts.cwd);
  if (!loadCube(r).rows.length) throw new CubeError("There's no cube to install. Build one first with `npx context-cube`.");
  const tool = installTool(r);
  const out = await installAgents(r, undefined, { shared: opts.shared });
  return tool.updatedFrom ? [`Updated the project's copy of Context Cube from ${tool.updatedFrom} to ${version()}.`, ...out] : out;
}

export async function uninstall(opts: { cwd?: string }): Promise<string[]> {
  return uninstallAgents(root(opts.cwd));
}
