import { join } from "node:path";
import { readJsonOr, writeJson } from "./fsutil";
import { cubePaths, TOOL_COMMAND } from "./paths";
import { git, gitRoot } from "./git";
import { allBoxes, getRow, loadCube, type Box } from "./cube";
import { loadBoxState } from "./state/state";
import { openEntry } from "./history";
import { loadRecipe } from "./build/recipe";
import { CUBE_DIR } from "./paths";
import { loadConfig } from "./config";

/**
 * Keeping the cube current (plan 8.1–8.2). The main session knows what changed
 * and why, so it writes a short note; a helper on the cheap tier does the
 * mechanical work from the note and this plan.
 */

export interface CommitInfo {
  hash: string;
  subject: string;
  files: string[];
}

export function lastCommit(root: string, ref = "HEAD"): CommitInfo | undefined {
  if (!gitRoot(root)) return undefined;
  const r = git(["show", "--no-renames", "--name-only", "--format=%h%x1f%s", ref], root);
  if (!r.ok) return undefined;
  const [head, ...files] = r.stdout.split("\n");
  const [hash, subject] = head.split("\x1f");
  return { hash, subject: subject ?? "", files: files.map((f) => f.trim()).filter(Boolean) };
}

/** A commit that only touched the cube or agent settings needs no cube update. */
export function onlyCubeFiles(files: string[]): boolean {
  return files.length > 0 && files.every((f) => f === "CLAUDE.md" || f === "AGENTS.md" || f.startsWith(`${CUBE_DIR}/`) || f.startsWith(".claude/"));
}

/** A version or build number named in a commit subject, e.g. "1.0.8 (10)". */
export function keyFromSubject(root: string, subject: string): string | undefined {
  const recipe = loadRecipe(root);
  for (const ref of recipe?.refs.filter((r) => r.kind === "history") ?? []) {
    try {
      const m = new RegExp(ref.pattern).exec(subject);
      if (m?.[1]) return m[1].trim();
    } catch {
      // bad pattern; try the next
    }
  }
  const m = /\bv?(\d+\.\d+(?:\.\d+)?(?:\s*\(\d+\))?)/.exec(subject);
  return m?.[1];
}

export function linkedBoxes(root: string, files: string[]): Box[] {
  const set = new Set(files);
  const cube = loadCube(root);
  return allBoxes(cube).filter((b) => {
    if (b.isRoot || getRow(cube, b.rowNum)?.type === "history") return false;
    const code = loadBoxState(root, b.id)?.code?.files ?? [];
    return code.some((f) => set.has(f.path));
  });
}

export function updatePlan(root: string, opts: { commit?: CommitInfo; files?: string[]; reason?: string } = {}): string {
  const cube = loadCube(root);
  const files = opts.commit?.files ?? opts.files ?? [];
  const linked = linkedBoxes(root, files);
  const open = openEntry(cube);
  const unit = (() => {
    try {
      return loadConfig(root).history.unit;
    } catch {
      return undefined;
    }
  })();
  const key = opts.commit ? keyFromSubject(root, opts.commit.subject) : undefined;
  const c = TOOL_COMMAND;
  const lines = [
    opts.commit ? `Context Cube: update the project memory for commit ${opts.commit.hash} "${opts.commit.subject.slice(0, 100)}".` : `Context Cube: update the project memory for this session's work${opts.reason ? ` (${opts.reason})` : ""}.`,
    "1. Write a short note (2–4 sentences): what changed and why.",
    `2. Hand the note and this plan to the cube-updater agent (a helper on a cheap model), for example with the Task tool and subagent_type "cube-updater". If you can't use it, run the steps below yourself.`,
    "",
    "Plan for the helper:",
    `- Add the note to the open history entry: ${c} history add "<note>"${key ? ` --key "${key}"` : ""}${linked.length ? ` --touches ${linked.slice(0, 8).map((b) => b.id).join(",")}` : ""}`,
  ];
  if (open) lines.push(`  (open entry: ${open.id} ${open.name}${unit ? `; one entry per ${unit}` : ""})`);
  else lines.push(`  (no entry is open yet; that command opens one${unit ? `; one entry per ${unit}` : ""})`);
  if (linked.length) {
    const shown = linked.slice(0, 15);
    lines.push(
      "- These boxes are linked to the changed files. Check each against the change (a changed file doesn't mean the box is wrong). Its summary is what agents read first: if the change made it or the read-when line wrong, fix it. If its detail is wrong or incomplete, add a note below it saying what's true now (never rewrite or shorten what's there):",
    );
    for (const b of shown) {
      const hasZ4 = b.drawers.some((d) => d.z === 4);
      const z4 = hasZ4 ? `${c} write ${b.id} Z4 --append @<file>` : `${c} write ${b.id} Z4 @<file> (it has no Z4 yet: write one if you had to read code to understand it)`;
      lines.push(`  - ${b.id} ${b.name} (context-cube/${b.relDir}/): ${c} edit ${b.id} --summary "..." | ${z4}`);
    }
    if (linked.length > 15) lines.push(`  - …and ${linked.length - 15} more (${c} status lists them)`);
    lines.push(`- Then mark them checked, all in one command (it reads the code once): ${c} ok ${shown.map((b) => b.id).join(" ")}`);
  } else {
    lines.push(`- No boxes are linked to the changed files. If the change added a feature or component worth remembering, add a box: ${c} new-box <row> <name> --summary "..." --read-when "..."`);
  }
  lines.push(
    `- Never edit invariant text. If the change created or changed a rule that must never be broken, the main session proposes it: ${c} propose new <name> --summary "..." --read-when "..." --text @<file> --reason "..."`,
  );
  return lines.join("\n");
}

// ---------- per-session bookkeeping for the hooks ----------

export interface SessionMarks {
  edits: number;
  files?: string[];
  updateRequested?: boolean;
  handledCommits: string[];
}

function marksPath(root: string, session: string): string {
  return join(cubePaths(root).logs, "sessions", `${session.replace(/[^\w-]/g, "_")}.json`);
}

export function loadMarks(root: string, session: string): SessionMarks {
  return readJsonOr<SessionMarks>(marksPath(root, session), { edits: 0, handledCommits: [] });
}

export function saveMarks(root: string, session: string, m: SessionMarks): void {
  writeJson(marksPath(root, session), m);
}

const COMMIT_RE = /(?:^|[\s;&|(])(?:rtk\s+)?git\s+(?:-[^\s]+\s+)*commit\b/;

export function isCommitCommand(command: string): boolean {
  return COMMIT_RE.test(command) && !/\bcommit\s+--help\b/.test(command);
}
