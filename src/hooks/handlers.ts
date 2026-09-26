import { resolve } from "node:path";
import { registerHookHandler, type HookOutcome } from "../commands/hook";
import { sessionNotice } from "../core/code/notice";
import { relToRoot, TOOL_COMMAND, CUBE_DIR } from "../core/paths";
import { loadConfig } from "../core/config";
import { getBox, getRow, loadCube } from "../core/cube";
import { drawerRecord, isRecordBox, recordRefusal } from "../core/records";
import { ROW_DIR_RE } from "../core/format/ids";
import { gitRoot } from "../core/git";
import { isCommitCommand, lastCommit, loadMarks, onlyCubeFiles, saveMarks, updatePlan } from "../core/update";

/**
 * Hook behaviors beyond logging. Each checks its own feature flag, so one
 * installed hook entry can serve several features.
 */

// ---------- session start: stale boxes linked to recent work (plan 8.4) ----------

registerHookHandler(async (event, input, root, features) => {
  if (event !== "session-start" || !features.has("session")) return;
  if (input.source === "compact") return;
  const notice = sessionNotice(root);
  return notice ? { exitCode: 0, stdout: notice } : undefined;
});

// ---------- guard: protected files and person-only commands (plan 9.2, 9.3) ----------

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function protectedReason(root: string, file: string): string | undefined {
  const rel = relToRoot(root, resolve(root, file));
  if (!rel.startsWith(`${CUBE_DIR}/`)) return undefined;
  const inner = rel.slice(CUBE_DIR.length + 1);
  if (inner === "cube.config.json") {
    return `Context Cube settings can't be edited directly. Change one with: ${TOOL_COMMAND} config set <setting> <value> (the person is asked to confirm). See the settings with: ${TOOL_COMMAND} config get`;
  }
  const m = /^(Y\d{2}-[^/]+)\/(X\d+)-[^/]+\/Z1-invariants\.md$/.exec(inner);
  if (m) {
    const rowDir = ROW_DIR_RE.exec(m[1]);
    const row = rowDir ? getRow(loadCube(root), Number(rowDir[1])) : undefined;
    if (row?.type === "invariants") {
      const id = `${row.id}.${m[2]}`;
      return `Invariant text can't be edited directly. Write the new text of ${id}'s Z1 to a file, then run: ${TOOL_COMMAND} propose edit ${id} --text @<file> --reason "<why>". A person approves it (see pending ones with: ${TOOL_COMMAND} pending). To remove it: ${TOOL_COMMAND} propose delete ${id} --reason "<why>".`;
    }
  }
  const d = /^(Y\d{2}-[^/]+)\/(X\d+)-[^/]+\/Z(\d)-[a-z]+\.md$/.exec(inner);
  if (d) {
    const cube = loadCube(root);
    const rowDir = ROW_DIR_RE.exec(d[1]);
    const row = rowDir ? getRow(cube, Number(rowDir[1])) : undefined;
    const box = row ? getBox(cube, `${row.id}.${d[2]}`) : undefined;
    const rec = box ? drawerRecord(root, cube, box, Number(d[3])) : undefined;
    if (rec) return `${recordRefusal(rec)}\nDon't edit its file directly.`;
  }
  if (inner.startsWith(".state/")) return `${rel} is tool-owned bookkeeping. Change the cube with ${TOOL_COMMAND} commands (${TOOL_COMMAND} --help lists them).`;
  if (inner.startsWith(".tool/")) return `${rel} is the tool itself. Update it by reinstalling Context Cube.`;
  if (inner === "CUBE.md" || /\/ROW(-p\d+)?\.md$/.test(inner)) return `${rel} is generated. Change the boxes instead, then run: ${TOOL_COMMAND} index`;
  return undefined;
}

const PROTECTED_IN_BASH = /(context-cube\/(?:cube\.config\.json|\.state\/|\.tool\/)|Z1-invariants\.md)/;
const WRITES_IN_BASH = /(>|\btee\b|\bsed\s+(-\w*\s+)*-i|\bperl\s+(-\w*\s+)*-i|\bmv\b|\bcp\b|\brm\b|\btruncate\b|\bdd\b|\bpython3?\b|\bnode\s+-e\b|\bruby\s+-e\b)/;
const PERSON_ONLY = /(?:cube(?:\.mjs)?|context-cube)["']?\s+(config\s+set|approve|reject|restore|replace)\b/;
const DELETE_CMD = /(?:cube(?:\.mjs)?|context-cube)["']?\s+delete\s+([^;&|\n]*)/;
const ARCHIVE_IN_BASH = /context-cube\/\.state\/archive\b/;

/** The box a `cube delete` names, wherever its options are. */
function deleteTarget(cmd: string): string | undefined {
  const rest = DELETE_CMD.exec(cmd)?.[1];
  if (rest === undefined) return undefined;
  const id = /\bY\d{2}\.X\d+\b/.exec(rest);
  if (id) return id[0];
  const words = rest.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "--reason") i++;
    else if (!words[i].startsWith("-")) return words[i].replace(/^["']|["']$/g, "");
  }
  return undefined;
}

const PERSON_ONLY_WHAT: Record<string, string> = {
  approve: "Approving an invariant change",
  reject: "Rejecting an invariant change",
  restore: "Putting an archived original file back",
  replace: "Replacing a record's text",
};

/** Asks the person to confirm, or blocks when this session skips permission prompts. */
function needsPerson(what: string, cmd: string, input: Record<string, unknown>): HookOutcome {
  const mode = String(input.permission_mode ?? "default");
  if (mode === "bypassPermissions" || mode === "dontAsk") {
    return {
      exitCode: 2,
      stderr: `${what} needs a person, and this session skips permission prompts. Ask the person to run it themselves (in Claude Code they can type: ! ${cmd.trim()}).`,
    };
  }
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `${what} needs a person to confirm.`,
      },
    }),
  };
}

/** Why the agent is kept out of the archive, and where to look instead. */
export const ARCHIVE_REASON = `context-cube/.state/archive/ holds original memory files whose content now lives in the cube, word for word. Read the cube instead: start at context-cube/CUBE.md, or search it with: ${TOOL_COMMAND} find <words>. If the person wants an original file back, they can run: ${TOOL_COMMAND} restore <file>`;

registerHookHandler(async (event, input, root, features): Promise<HookOutcome | void> => {
  if (event !== "pre-tool-use" || !features.has("guard")) return;
  const tool = input.tool_name ?? "";
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;
  if (EDIT_TOOLS.has(tool)) {
    const file = String(ti.file_path ?? ti.notebook_path ?? "");
    const reason = file ? protectedReason(root, file) : undefined;
    if (reason) return { exitCode: 2, stderr: reason };
    return;
  }
  if (tool !== "Bash") return;
  const cmd = String(ti.command ?? "");
  const usesTool = /context-cube\/\.tool\/cube\.mjs|\bcube\s|npx\s+context-cube/.test(cmd);
  if (ARCHIVE_IN_BASH.test(cmd) && !usesTool) return { exitCode: 2, stderr: ARCHIVE_REASON };
  if (PROTECTED_IN_BASH.test(cmd) && WRITES_IN_BASH.test(cmd) && !usesTool) {
    const file = PROTECTED_IN_BASH.exec(cmd)![1];
    const reason = file.startsWith("context-cube")
      ? protectedReason(root, file)
      : `Invariant text can't be changed directly. Write the new Z1 text to a file, then run: ${TOOL_COMMAND} propose edit <box id> --text @<file> --reason "<why>". A person approves it.`;
    return { exitCode: 2, stderr: reason ?? `That command would change a file Context Cube protects. Use ${TOOL_COMMAND} commands instead.` };
  }
  const m = PERSON_ONLY.exec(cmd);
  if (m) return needsPerson(m[1].startsWith("config") ? "Changing a Context Cube setting" : PERSON_ONLY_WHAT[m[1]], cmd, input);
  const target = deleteTarget(cmd);
  if (target) {
    const cube = loadCube(root);
    const box = getBox(cube, target);
    if (box && isRecordBox(root, cube, box)) return needsPerson(`Deleting ${box.id}, which holds a record (text moved from the original files, or a closed history entry),`, cmd, input);
  }
});

// ---------- update: after a commit, or at the end of work (plan 8.1) ----------

registerHookHandler(async (event, input, root, features): Promise<HookOutcome | void> => {
  if (!features.has("update")) return;
  const session = String(input.session_id ?? "unknown");
  let trigger: string;
  try {
    trigger = loadConfig(root).update.trigger;
  } catch {
    trigger = "commit";
  }
  if (!gitRoot(root) && trigger === "commit") trigger = "stop";

  if (event === "post-tool-use") {
    const tool = input.tool_name ?? "";
    const ti = (input.tool_input ?? {}) as Record<string, unknown>;
    if (EDIT_TOOLS.has(tool)) {
      const marks = loadMarks(root, session);
      const f = relToRoot(root, String(ti.file_path ?? ti.notebook_path ?? ""));
      if (!f.startsWith(`${CUBE_DIR}/`)) {
        marks.edits++;
        marks.files = [...new Set([...(marks.files ?? []), f])].slice(-200);
        saveMarks(root, session, marks);
      }
      return;
    }
    if (tool !== "Bash" || trigger !== "commit") return;
    if (!isCommitCommand(String(ti.command ?? ""))) return;
    const commit = lastCommit(root);
    if (!commit || onlyCubeFiles(commit.files)) return;
    const marks = loadMarks(root, session);
    if (marks.handledCommits.includes(commit.hash)) return;
    marks.handledCommits.push(commit.hash);
    marks.updateRequested = true;
    saveMarks(root, session, marks);
    return {
      exitCode: 0,
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: updatePlan(root, { commit }) } }),
    };
  }

  if (event === "stop") {
    if (input.stop_hook_active || trigger !== "stop") return;
    const marks = loadMarks(root, session);
    if (marks.updateRequested || marks.edits === 0) return;
    marks.updateRequested = true;
    saveMarks(root, session, marks);
    return { exitCode: 0, stdout: JSON.stringify({ decision: "block", reason: updatePlan(root, { files: marks.files ?? [], reason: "before finishing" }) }) };
  }
});
