import { resolve } from "node:path";
import { registerHookHandler, type HookOutcome } from "../commands/hook";
import { sessionNotice } from "../core/code/notice";
import { setUpClone } from "../core/install";
import { relToRoot, TOOL_COMMAND, CUBE_DIR } from "../core/paths";
import { loadConfig } from "../core/config";
import { getBox, getRow, loadCube } from "../core/cube";
import { drawerRecord, isRecordBox, recordRefusal } from "../core/records";
import { ROW_DIR_RE } from "../core/format/ids";
import { gitRoot } from "../core/git";
import { isCommitCommand, lastCommit, loadMarks, onlyCubeFiles, saveMarks, updatePlan } from "../core/update";
import { dialectFor, getAdapter } from "../adapters/registry";
import type { HookDialect } from "../adapters/types";
import { pathRulesFor, rulesForFile } from "../core/code/pathRules";
import { bashReadFiles } from "../core/logs/extract";

/**
 * Hook behaviors beyond logging. Each checks its own feature flag, so one
 * installed hook entry can serve several features.
 */

// ---------- session start: stale boxes linked to recent work (plan 8.4) ----------

registerHookHandler(async (event, input, root, features) => {
  if (event !== "session-start" || !features.has("session")) return;
  if (input.source === "compact") return;
  // A clone that only pulled the cube (a teammate's) gets set up for its merges and commits.
  let setUp: string[] = [];
  try {
    setUp = setUpClone(root);
  } catch {
    // Setting up git must never stop a session.
  }
  const notice = [setUp.length ? `Context Cube set up this clone: ${setUp.join(", ")}.` : "", sessionNotice(root) ?? ""].filter(Boolean).join("\n");
  return notice ? { exitCode: 0, stdout: notice } : undefined;
});

// ---------- guard: protected files and person-only commands (plan 9.2, 9.3) ----------

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
/** Commands that change the files they're given. */
const WRITER_VERBS = /\btee\b|\bsed\s+(-\w*\s+)*-i|\bperl\s+(-\w*\s+)*-i|\bmv\b|\brm\b|\btruncate\b|\bdd\b|\bln\b|\btouch\b|\bchmod\b|\binstall\s/;
/** A script can write anything; it counts as a writer when its text looks like it writes. */
const SCRIPTS = /\b(?:python3?|node|ruby|perl|php|deno|bun)\b/;
const SCRIPT_WRITES = /open\([^)]*['"][wax+]|\.write\(|write_text|write_bytes|writeFile|appendFile|createWriteStream|rmSync|unlink|rename|rmtree|os\.remove|shutil\.|truncate|File\.write|IO\.write/;
const PERSON_ONLY = /(?:cube(?:\.mjs)?|context-cube)["']?\s+(config\s+set|approve|reject|restore|replace)\b/;
const DELETE_AT = /(?:cube(?:\.mjs)?|context-cube)["']?\s+delete\b/g;
const ARCHIVE_IN_BASH = /context-cube\/\.state\/archive\b/;

/**
 * Where a shell command's output redirections go, outside quotes: `> f`,
 * `>> f`, `2> f`, `&> f`, `>| f`. Not `2>&1` or `>&2` (another descriptor),
 * and not `/dev/null`. A process substitution `>(…)` counts as "(" (unknown).
 */
export function redirectTargets(cmd: string): string[] {
  const out: string[] = [];
  let quote: string | undefined;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === "\\" && quote === '"') i++;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\") i++;
    else if (ch === ">") {
      let j = i + 1;
      if (cmd[j] === ">" || cmd[j] === "|") j++;
      if (cmd[j] === "&") {
        i = j;
        continue;
      }
      if (cmd[j] === "(") {
        out.push("(");
        i = j;
        continue;
      }
      while (cmd[j] === " " || cmd[j] === "\t") j++;
      const target = commandWords(cmd.slice(j))[0] ?? "";
      if (target && target !== "/dev/null") out.push(target);
      i = j;
    }
  }
  return out;
}

/** The protected file a shell command would change, if it would change one. Reading one is fine. */
export function protectedWrite(cmd: string): string | undefined {
  const redirected = redirectTargets(cmd).find((t) => t === "(" || PROTECTED_IN_BASH.test(t));
  if (redirected) return redirected === "(" ? PROTECTED_IN_BASH.exec(cmd)?.[1] : PROTECTED_IN_BASH.exec(redirected)![1];
  const named = PROTECTED_IN_BASH.exec(cmd)?.[1];
  if (!named) return undefined;
  if (WRITER_VERBS.test(cmd)) return named;
  // `cp` changes only where it copies to: its last argument.
  for (const m of cmd.matchAll(/\bcp\b/g)) {
    const dest = commandWords(cmd.slice(m.index! + 2)).filter((w) => !w.startsWith("-")).pop();
    if (dest && PROTECTED_IN_BASH.test(dest)) return named;
  }
  if (SCRIPTS.test(cmd) && SCRIPT_WRITES.test(cmd)) return named;
  return undefined;
}

/** The shell words from here to the end of one simple command (an unquoted ; & | ) or newline), quotes removed. */
function commandWords(s: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < s.length) {
      cur += s[++i];
      inWord = true;
    } else if (/[;&|)\n]/.test(ch)) {
      break;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

/**
 * The boxes named by every `cube delete` in a shell command, wherever their
 * options are (a --reason may itself name a box). `unknown` when one names its
 * box through a variable or command substitution.
 */
export function deleteTargets(cmd: string): { ids: string[]; unknown: boolean } {
  const ids: string[] = [];
  let unknown = false;
  for (const m of cmd.matchAll(DELETE_AT)) {
    const words = commandWords(cmd.slice(m.index! + m[0].length));
    for (let i = 0; i < words.length; i++) {
      if (words[i] === "--reason") i++;
      else if (!words[i].startsWith("-")) {
        if (/[$`]/.test(words[i])) unknown = true;
        else ids.push(words[i]);
        break;
      }
    }
  }
  return { ids, unknown };
}

const PERSON_ONLY_WHAT: Record<string, string> = {
  approve: "Approving an invariant change",
  reject: "Rejecting an invariant change",
  restore: "Putting an archived original file back",
  replace: "Replacing a record's text",
};

/**
 * Asks the person to confirm, or blocks when this session skips permission
 * prompts. An agent whose hooks can't ask (Codex) has its own command rules
 * ask instead, for a command shaped so the rules match it; anything else is
 * blocked with how to run it.
 */
function needsPerson(what: string, cmd: string, input: Record<string, unknown>, root: string, dialect: HookDialect): HookOutcome {
  const mode = String(input.permission_mode ?? "default");
  if (mode === "bypassPermissions" || mode === "dontAsk") {
    return { exitCode: 2, stderr: `${what} needs a person, and this session skips permission prompts. ${dialect.personRuns(cmd.trim())}.` };
  }
  if (dialect.personPrompt === "rules") {
    if (dialect.rulesWillAsk?.(root, cmd)) return { exitCode: 0 };
    return {
      exitCode: 2,
      stderr: `${what} needs a person's yes. Run it on its own, as \`${TOOL_COMMAND} <command> …\` with nothing before or after it in the same command, and Codex asks the person to confirm it. Or: ${dialect.personRuns(cmd.trim())}.`,
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

registerHookHandler(async (event, input, root, features, agent): Promise<HookOutcome | void> => {
  if (event !== "pre-tool-use" || !features.has("guard")) return;
  const dialect = dialectFor(agent);
  const call = dialect.toolCall(input);
  const cwd = input.cwd || root;
  if (call.kind === "edit") {
    for (const file of call.files) {
      const reason = protectedReason(root, resolve(cwd, file));
      if (reason) return { exitCode: 2, stderr: reason };
    }
    return ruleNotices(root, agent, input, call.files.map((f) => resolve(cwd, f)));
  }
  if (call.kind !== "shell") return;
  const cmd = call.command;
  const usesTool = /context-cube\/\.tool\/cube\.mjs|\bcube\s|npx\s+context-cube/.test(cmd);
  if (ARCHIVE_IN_BASH.test(cmd) && !usesTool) return { exitCode: 2, stderr: ARCHIVE_REASON };
  const file = usesTool ? undefined : protectedWrite(cmd);
  if (file) {
    const reason = file.startsWith("context-cube")
      ? protectedReason(root, file)
      : `Invariant text can't be changed directly. Write the new Z1 text to a file, then run: ${TOOL_COMMAND} propose edit <box id> --text @<file> --reason "<why>". A person approves it.`;
    return { exitCode: 2, stderr: reason ?? `That command would change a file Context Cube protects. Use ${TOOL_COMMAND} commands instead.` };
  }
  const m = PERSON_ONLY.exec(cmd);
  if (m) return needsPerson(m[1].startsWith("config") ? "Changing a Context Cube setting" : PERSON_ONLY_WHAT[m[1]], cmd, input, root, dialect);
  const del = deleteTargets(cmd);
  if (del.ids.length || del.unknown) {
    const cube = loadCube(root);
    const records = del.ids.flatMap((id) => {
      const box = getBox(cube, id);
      return box && isRecordBox(root, cube, box) ? [box.id] : [];
    });
    if (records.length === 1) return needsPerson(`Deleting ${records[0]}, which holds a record (text moved from the original files, or a closed history entry),`, cmd, input, root, dialect);
    if (records.length) return needsPerson(`Deleting ${records.join(", ")}, which hold records (text moved from the original files, or closed history entries),`, cmd, input, root, dialect);
    if (del.unknown) return needsPerson("Deleting a box named through a shell variable (it may hold a record)", cmd, input, root, dialect);
  }
});

// ---------- rule notices, for agents without path rule files (plan 8.5) ----------

/**
 * Claude Code loads a path rule when the agent reads or edits a file an
 * invariant governs. Codex has no such rule files, so its guard hook adds the
 * same one-line rules as context: before an edit, and after a shell command
 * that printed the file. Each rule once per session.
 */
function ruleNotices(root: string, agent: string, input: Record<string, unknown>, files: string[]): HookOutcome | undefined {
  if (getAdapter(agent).capabilities.pathRules || !files.length) return undefined;
  const rels = files.map((f) => relToRoot(root, f)).filter((f) => !f.startsWith("/") && !f.startsWith(`${CUBE_DIR}/`));
  if (!rels.length) return undefined;
  const rules = pathRulesFor(loadCube(root));
  if (!rules.length) return undefined;
  const session = String(input.session_id ?? "unknown");
  const marks = loadMarks(root, session);
  const shown = new Set(marks.shownRules ?? []);
  const out: string[] = [];
  for (const rel of rels) {
    const fresh = rulesForFile(rules, rel).filter((r) => !shown.has(r.id));
    if (!fresh.length) continue;
    out.push(`For ${rel}:`, ...fresh.map((r) => r.body.trim()));
    fresh.forEach((r) => shown.add(r.id));
  }
  if (!out.length) return undefined;
  marks.shownRules = [...shown];
  saveMarks(root, session, marks);
  return { exitCode: 0, context: out.join("\n") };
}

registerHookHandler(async (event, input, root, features, agent): Promise<HookOutcome | void> => {
  if (event !== "post-tool-use" || !features.has("guard")) return;
  const call = dialectFor(agent).toolCall(input);
  if (call.kind !== "shell") return;
  return ruleNotices(root, agent, input, bashReadFiles(call.command, input.cwd || root));
});

// ---------- update: after a commit, or at the end of work (plan 8.1) ----------

registerHookHandler(async (event, input, root, features, agent): Promise<HookOutcome | void> => {
  if (!features.has("update")) return;
  const dialect = dialectFor(agent);
  const session = String(input.session_id ?? "unknown");
  let trigger: string;
  try {
    trigger = loadConfig(root).update.trigger;
  } catch {
    trigger = "commit";
  }
  if (!gitRoot(root) && trigger === "commit") trigger = "stop";

  if (event === "post-tool-use") {
    const call = dialect.toolCall(input);
    if (call.kind === "edit") {
      const marks = loadMarks(root, session);
      const files = call.files.map((f) => relToRoot(root, resolve(input.cwd || root, f))).filter((f) => !f.startsWith(`${CUBE_DIR}/`));
      if (files.length) {
        marks.edits++;
        marks.files = [...new Set([...(marks.files ?? []), ...files])].slice(-200);
        saveMarks(root, session, marks);
      }
      return;
    }
    if (call.kind !== "shell" || trigger !== "commit") return;
    if (!isCommitCommand(call.command)) return;
    const commit = lastCommit(root);
    if (!commit || onlyCubeFiles(commit.files)) return;
    const marks = loadMarks(root, session);
    if (marks.handledCommits.includes(commit.hash)) return;
    marks.handledCommits.push(commit.hash);
    marks.updateRequested = true;
    saveMarks(root, session, marks);
    return { exitCode: 0, context: updatePlan(root, { commit, helper: dialect.updateHelper }) };
  }

  if (event === "stop") {
    if (input.stop_hook_active || trigger !== "stop") return;
    const marks = loadMarks(root, session);
    if (marks.updateRequested || marks.edits === 0) return;
    marks.updateRequested = true;
    saveMarks(root, session, marks);
    return { exitCode: 0, stdout: JSON.stringify({ decision: "block", reason: updatePlan(root, { files: marks.files ?? [], reason: "before finishing", helper: dialect.updateHelper }) }) };
  }
});
