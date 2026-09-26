import { readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { appendLine, exists, readJson, readTextOr, remove, writeJson, writeText } from "./fsutil";
import { cubePaths } from "./paths";
import { loadConfig } from "./config";
import { allBoxes, drawerPath, getBox, getRow, loadCube, type Box } from "./cube";
import { bulkUpdateHeaders, createBox, CubeError, deleteBox, touchState } from "./ops";
import { joinGenerated, splitGenerated } from "./format/generated";
import { loadBoxState, saveBoxState, sha } from "./state/state";
import { gitUser } from "./git";
import { recordQuality } from "./stats/ai";
import { keepDeletedBox } from "./records";

/**
 * Invariant approval (plan 9). New invariants go in at once, marked pending,
 * so agents still see them. Edits and deletions of approved invariant text
 * wait in .state/pending/ until a person runs `cube approve`. In `auto` mode
 * they apply at once and are logged as not reviewed by a person. Every change
 * is its own labeled entry in .state/approvals.log.
 */

export interface Proposal {
  id: string;
  kind: "edit" | "delete" | "new";
  box: string;
  name: string;
  reason: string;
  by: string;
  created: string;
  /** Checksum of the approved text the proposal was made against. */
  baseSha?: string;
  oldText?: string;
  newText?: string;
  weakens: boolean;
}

export interface ApprovalLog {
  t: string;
  proposal: string;
  kind: Proposal["kind"];
  box: string;
  decision: "approved" | "rejected" | "applied-automatically";
  by: string;
  reviewedByPerson: boolean;
  reason: string;
  proposedBy: string;
  weakens: boolean;
  /** A deleted invariant's folder, kept in the archive. */
  kept?: string;
}

function pendingDir(root: string): string {
  return cubePaths(root).pending;
}

export function listProposals(root: string): Proposal[] {
  const dir = pendingDir(root);
  if (!exists(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readJson<Proposal>(join(dir, f)));
}

function saveProposal(root: string, p: Proposal): void {
  writeJson(join(pendingDir(root), `${p.id}.json`), p);
}

function dropProposal(root: string, id: string): void {
  remove(join(pendingDir(root), `${id}.json`));
}

export function z1Own(box: Box): string {
  return splitGenerated(readTextOr(drawerPath(box, 1), "")).own;
}

function invariantBox(root: string, id: string): Box {
  const cube = loadCube(root);
  const box = getBox(cube, id);
  if (!box || box.isRoot) throw new CubeError(`No box ${id}.`);
  if (getRow(cube, box.rowNum)!.type !== "invariants") throw new CubeError(`${box.id} isn't in an invariants row; edit it directly with \`cube write\`.`);
  return box;
}

const RULE_WORDS = /\b(never|must|always|only|required|require|cannot|can't|don't|do not|no\s+\w+|forbid|prohibit|mustn't|shall)\b/i;

/** Line-based diff (longest common subsequence). */
export function diffLines(a: string, b: string): { op: " " | "-" | "+"; line: string }[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const m = x.length;
  const n = y.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { op: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) {
      out.push({ op: " ", line: x[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", line: x[i++] });
    else out.push({ op: "+", line: y[j++] });
  }
  while (i < m) out.push({ op: "-", line: x[i++] });
  while (j < n) out.push({ op: "+", line: y[j++] });
  return out;
}

/** Does this change remove or loosen a rule? Flagged so nobody approves one without noticing. */
export function weakens(oldText: string, newText: string): boolean {
  const d = diffLines(oldText, newText);
  const removedRules = d.filter((l) => l.op === "-" && RULE_WORDS.test(l.line)).length;
  const addedRules = d.filter((l) => l.op === "+" && RULE_WORDS.test(l.line)).length;
  if (removedRules > addedRules) return true;
  if (newText.trim().length < oldText.trim().length * 0.8) return true;
  return d.some((l) => l.op === "-" && RULE_WORDS.test(l.line)) && !d.some((l) => l.op === "+");
}

function who(root: string): string {
  return gitUser(root) ?? process.env.USER ?? "someone";
}

function newId(): string {
  const t = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  return `P-${t}-${randomBytes(2).toString("hex")}`;
}

function logDecision(root: string, entry: ApprovalLog): void {
  appendLine(cubePaths(root).approvals, JSON.stringify(entry));
}

export interface ProposeResult {
  proposal: Proposal;
  applied: boolean;
}

function autoMode(root: string): boolean {
  return loadConfig(root).invariants.approval === "auto";
}

export function proposeEdit(root: string, id: string, newText: string, reason: string, by?: string): ProposeResult {
  if (!reason.trim()) throw new CubeError('Say why with --reason "...": it goes in the approvals log.');
  const box = invariantBox(root, id);
  const oldText = z1Own(box);
  let text = newText.endsWith("\n") ? newText : `${newText}\n`;
  // Keep the blank lines that ended the old text (they separate it from the next topic in the source).
  const trailing = /\n*$/.exec(oldText)![0];
  if (trailing.length > 1 && !/\n\n$/.test(text)) text = text.replace(/\n*$/, trailing);
  if (text === oldText) throw new CubeError(`That's the same as ${box.id}'s current text.`);
  const p: Proposal = {
    id: newId(),
    kind: "edit",
    box: box.id,
    name: box.name,
    reason,
    by: by ?? who(root),
    created: new Date().toISOString(),
    baseSha: sha(oldText),
    oldText,
    newText: text,
    weakens: weakens(oldText, text),
  };
  if (autoMode(root)) {
    applyProposal(root, p, "applied-automatically", false, p.by, reason);
    return { proposal: p, applied: true };
  }
  saveProposal(root, p);
  return { proposal: p, applied: false };
}

export function proposeDelete(root: string, id: string, reason: string, by?: string): ProposeResult {
  if (!reason.trim()) throw new CubeError('Say why with --reason "...": it goes in the approvals log.');
  const box = invariantBox(root, id);
  const p: Proposal = { id: newId(), kind: "delete", box: box.id, name: box.name, reason, by: by ?? who(root), created: new Date().toISOString(), oldText: z1Own(box), weakens: true };
  if (autoMode(root)) {
    applyProposal(root, p, "applied-automatically", false, p.by, reason);
    return { proposal: p, applied: true };
  }
  saveProposal(root, p);
  return { proposal: p, applied: false };
}

export interface NewInvariant {
  name: string;
  summary: string;
  readWhen: string;
  text: string;
  reason: string;
  by?: string;
  scope?: string;
}

/** A new invariant goes in at once, marked pending (or ok in auto mode), so agents see it. */
export function proposeNew(root: string, inv: NewInvariant): ProposeResult {
  if (!inv.reason.trim()) throw new CubeError('Say why with --reason "...": it goes in the approvals log.');
  const cube = loadCube(root);
  const row = cube.rows.find((r) => r.type === "invariants");
  if (!row) throw new CubeError("This cube has no invariants row.");
  const auto = autoMode(root);
  const text = inv.text.endsWith("\n") ? inv.text : `${inv.text}\n`;
  const box = createBox(root, row.num, { name: inv.name, summary: inv.summary, readWhen: inv.readWhen, drawers: { 1: text }, status: auto ? "ok" : "pending", writtenBy: "person" });
  const p: Proposal = { id: newId(), kind: "new", box: box.id, name: box.name, reason: inv.reason, by: inv.by ?? who(root), created: new Date().toISOString(), newText: text, weakens: false };
  if (auto) {
    approveText(root, box.id, text);
    logDecision(root, { t: new Date().toISOString(), proposal: p.id, kind: "new", box: box.id, decision: "applied-automatically", by: p.by, reviewedByPerson: false, reason: inv.reason, proposedBy: p.by, weakens: false });
    return { proposal: p, applied: true };
  }
  saveProposal(root, p);
  return { proposal: p, applied: false };
}

/** Records `text` as the approved Z1 of a box. */
export function approveText(root: string, id: string, text: string): void {
  const st = loadBoxState(root, id);
  if (!st) return;
  st.approvedZ1 = sha(text);
  saveBoxState(root, st);
}

function applyProposal(root: string, p: Proposal, decision: ApprovalLog["decision"], byPerson: boolean, by: string, reason: string): void {
  let kept: string | undefined;
  const cube = loadCube(root);
  const box = getBox(cube, p.box);
  if (!box) throw new CubeError(`${p.box} no longer exists.`);
  if (p.kind === "edit") {
    const current = z1Own(box);
    if (p.baseSha && sha(current) !== p.baseSha) {
      throw new CubeError(`${box.id}'s text changed since this was proposed. Reject it and propose again against the current text.`);
    }
    const path = drawerPath(box, 1);
    const { generated } = splitGenerated(readTextOr(path, ""));
    writeText(path, joinGenerated(p.newText!, generated));
    touchState(root, box.id, box.dir);
    approveText(root, box.id, p.newText!);
  } else if (p.kind === "delete") {
    kept = keepDeletedBox(root, box);
    deleteBox(root, box.id, `deleted with approval: ${p.reason}`);
  } else {
    approveText(root, box.id, z1Own(box));
    bulkUpdateHeaders(root, new Map([[box.id, { status: "ok" }]]));
  }
  logDecision(root, { t: new Date().toISOString(), proposal: p.id, kind: p.kind, box: p.box, decision, by, reviewedByPerson: byPerson, reason, proposedBy: p.by, weakens: p.weakens, ...(kept ? { kept } : {}) });
}

function findProposal(root: string, ref: string): Proposal {
  const all = listProposals(root);
  const p = all.find((x) => x.id === ref) ?? all.find((x) => x.box === ref);
  if (!p) throw new CubeError(`No pending proposal ${ref}. See them with: cube pending`);
  return p;
}

export function approve(root: string, ref: string, reason = ""): Proposal {
  const p = findProposal(root, ref);
  applyProposal(root, p, "approved", true, who(root), reason || p.reason);
  dropProposal(root, p.id);
  recordQuality(root, { kind: "proposal-approved", step: "update", id: p.box });
  return p;
}

export function reject(root: string, ref: string, reason: string): Proposal {
  if (!reason.trim()) throw new CubeError('Say why with --reason "...": it goes in the approvals log.');
  const p = findProposal(root, ref);
  if (p.kind === "new") deleteBox(root, p.box, `new invariant rejected: ${reason}`);
  logDecision(root, { t: new Date().toISOString(), proposal: p.id, kind: p.kind, box: p.box, decision: "rejected", by: who(root), reviewedByPerson: true, reason, proposedBy: p.by, weakens: p.weakens });
  dropProposal(root, p.id);
  recordQuality(root, { kind: "proposal-rejected", step: "update", id: p.box });
  return p;
}

/** Invariants whose Z1 differs from the approved text (edited some other way). */
export function unapprovedChanges(root: string): { id: string; name: string }[] {
  const cube = loadCube(root);
  const out: { id: string; name: string }[] = [];
  for (const box of allBoxes(cube)) {
    if (box.isRoot || getRow(cube, box.rowNum)?.type !== "invariants") continue;
    const approved = loadBoxState(root, box.id)?.approvedZ1;
    if (!approved) continue;
    if (sha(z1Own(box)) !== approved) out.push({ id: box.id, name: box.name });
  }
  return out;
}

export function renderProposal(p: Proposal): string {
  const head =
    p.kind === "delete"
      ? `!! DELETES AN INVARIANT: ${p.box} ${p.name}`
      : p.kind === "new"
        ? `New invariant (in the cube now, marked pending): ${p.box} ${p.name}`
        : `${p.weakens ? "!! WEAKENS OR REMOVES A RULE: " : ""}Edit to ${p.box} ${p.name}`;
  const lines = [`${p.id}  ${head}`, `  proposed by ${p.by} on ${p.created.slice(0, 10)}. Why: ${p.reason}`];
  if (p.kind === "edit") {
    for (const d of diffLines(p.oldText ?? "", p.newText ?? "")) if (d.op !== " ") lines.push(`  ${d.op === "-" ? "−" : "+"} ${d.line}`);
  } else if (p.kind === "delete") {
    for (const l of (p.oldText ?? "").split("\n").filter(Boolean).slice(0, 12)) lines.push(`  − ${l}`);
  } else {
    for (const l of (p.newText ?? "").split("\n").filter(Boolean).slice(0, 12)) lines.push(`  + ${l}`);
  }
  return lines.join("\n");
}
