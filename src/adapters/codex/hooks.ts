import { dirname, join, relative } from "node:path";
import { readdirSync } from "node:fs";
import { isDir, remove } from "../../core/fsutil";
import { deleteManifest, emptyManifest, loadManifest, saveManifest } from "../../core/installs";
import { splitCommand } from "../../core/logs/shell";
import type { HookDialect, HookFeature, HookPlan, SettingsScope } from "../types";
import { addHooks, loadSettings, readRaw, removeHooks, saveOrRemove, saveRestoring, type HookEntry } from "../shared/jsonSettings";
import { excludeLocally, unexcludeLocally } from "../claude-code/hooks";
import { TOOL_COMMAND } from "../../core/paths";

export const CODEX_ID = "codex";

/**
 * Codex hooks (.codex/hooks.json). Codex's hooks follow Claude Code's shape
 * (the same event names, exit code 2 to block, hookSpecificOutput with
 * additionalContext, Stop's decision "block"), with these differences
 * (from Codex's hooks docs, 2026-09-27):
 * - Edits arrive as tool_name "apply_patch", the patch text in tool_input.command.
 * - There's no project-folder variable; commands run in the session's folder,
 *   which may be below the project root, so the command finds the tool itself.
 * - permissionDecision "ask" is ignored, so person-only commands are left to
 *   Codex's command rules (rules.ts), which can ask.
 * - Project hooks run only after each person trusts the project's .codex/ folder.
 * - There's no per-project personal settings file: "personal" hooks go in the
 *   same file, kept out of git.
 */

export function hooksPath(root: string): string {
  return join(root, ".codex", "hooks.json");
}

interface EventSpec {
  event: string;
  cli: string;
  matchers?: string[];
  timeout: number;
}

/** Codex has no Read tool and no path rules, so files read through the shell get their invariant notices after the command (guard). */
const FEATURE_EVENTS: Record<HookFeature, EventSpec[]> = {
  // The read logger isn't supported for Codex yet.
  log: [],
  session: [{ event: "SessionStart", cli: "session-start", timeout: 10 }],
  guard: [
    { event: "PreToolUse", cli: "pre-tool-use", matchers: ["Bash", "apply_patch"], timeout: 10 },
    { event: "PostToolUse", cli: "post-tool-use", matchers: ["Bash"], timeout: 10 },
  ],
  update: [
    { event: "PostToolUse", cli: "post-tool-use", matchers: ["Bash", "apply_patch"], timeout: 10 },
    { event: "Stop", cli: "stop", timeout: 10 },
  ],
};

/**
 * Runs the project's copy of the tool from wherever the session is: it looks
 * for context-cube/.tool/cube.mjs in the session's folder and each folder
 * above, and does nothing if there isn't one. Written without $, backticks, or
 * double quotes, so every shell passes it to Node unchanged.
 */
export const LOCATE_TOOL =
  "const p=require('path'),f=require('fs');let d=process.cwd();for(;;){const t=p.join(d,'context-cube','.tool','cube.mjs');if(f.existsSync(t)){process.argv.splice(1,0,t);import(require('url').pathToFileURL(t).href);break}const u=p.dirname(d);if(u===d)break;d=u}";

export function isCodexHookCommand(command: string): boolean {
  return command.includes("'context-cube','.tool','cube.mjs'") && / hook [a-z-]+ --agent codex\b/.test(command);
}

export function hookEntries(features: HookFeature[]): HookEntry[] {
  const byEvent = new Map<string, { spec: EventSpec; features: Set<HookFeature>; matchers: Set<string> | undefined }>();
  for (const f of features) {
    for (const spec of FEATURE_EVENTS[f]) {
      const cur = byEvent.get(spec.event) ?? { spec, features: new Set(), matchers: spec.matchers ? new Set() : undefined };
      cur.features.add(f);
      if (spec.matchers && cur.matchers) spec.matchers.forEach((m) => cur.matchers!.add(m));
      byEvent.set(spec.event, cur);
    }
  }
  return [...byEvent.values()].map(({ spec, features: fs, matchers }) => ({
    event: spec.event,
    matcher: matchers ? `^(${[...matchers].join("|")})$` : undefined,
    command: `node -e "${LOCATE_TOOL}" hook ${spec.cli} --agent codex --features ${[...fs].sort().join(",")}`,
    timeout: spec.timeout,
  }));
}

/** Installs hooks for the given features into .codex/hooks.json, replacing ours already there. */
export function installCodexHooks(root: string, plan: HookPlan): { file: string; features: string[] } {
  const manifest = loadManifest(root, CODEX_ID, plan.scope) ?? emptyManifest(CODEX_ID, plan.scope);
  const features = [...new Set([...manifest.features, ...plan.features])].filter((f) => FEATURE_EVENTS[f as HookFeature].length).sort() as HookFeature[];
  const path = hooksPath(root);
  const dirExisted = isDir(dirname(path));
  const originalText = manifest.settings ? manifest.settings.originalText : readRaw(path);
  const file = loadSettings(path);
  removeHooks(file.data, isCodexHookCommand, manifest.settings ? { hooksKey: manifest.settings.hooksKey, events: manifest.settings.events } : undefined);
  const added = addHooks(file.data, hookEntries(features));
  const prev = manifest.settings;
  manifest.settings = {
    path: relative(root, path),
    created: prev ? prev.created : !file.existed,
    // For Codex, this records that the .codex folder was ours.
    claudeDirCreated: prev ? prev.claudeDirCreated : !dirExisted,
    hooksKey: prev ? prev.hooksKey || added.hooksKey : added.hooksKey,
    events: [...new Set([...(prev?.events ?? []), ...added.events])],
    originalText,
    excludeAdded: prev?.excludeAdded,
  };
  manifest.features = features;
  saveOrRemove(file, false);
  const rel = relative(root, path);
  // Personal hooks share the file with nobody: keep it out of git, if this install made it.
  if (plan.scope === "local" && manifest.settings.created && !manifest.settings.excludeAdded) manifest.settings.excludeAdded = excludeLocally(root, rel);
  if (plan.scope === "shared") liftLocalExclude(root, rel);
  saveManifest(root, manifest);
  return { file: path, features };
}

/** Moving hooks to the shared scope: the file must be committable again. */
function liftLocalExclude(root: string, rel: string): void {
  const local = loadManifest(root, CODEX_ID, "local");
  if (!local?.settings?.excludeAdded) return;
  unexcludeLocally(root, rel);
  local.settings.excludeAdded = false;
  saveManifest(root, local);
}

/** Removes the given features' hooks, keeping other features installed in the same file. */
export function uninstallCodexHooks(root: string, plan: HookPlan): { remaining: string[] } {
  const manifest = loadManifest(root, CODEX_ID, plan.scope);
  const path = hooksPath(root);
  const remaining = (manifest?.features ?? []).filter((f) => !plan.features.includes(f as HookFeature)) as HookFeature[];
  if (!manifest?.settings) {
    if (manifest) finishManifest(root, plan.scope, remaining);
    return { remaining };
  }
  const file = loadSettings(path);
  const containers = { hooksKey: manifest.settings.hooksKey, events: manifest.settings.events };
  removeHooks(file.data, isCodexHookCommand, remaining.length ? { hooksKey: false, events: [] } : containers);
  if (remaining.length) {
    addHooks(file.data, hookEntries(remaining));
    for (const e of manifest.settings.events) if (Array.isArray(file.data.hooks?.[e]) && !file.data.hooks[e].length) delete file.data.hooks[e];
  }
  const created = manifest.settings.created;
  if (file.existed) {
    if (!remaining.length && !created) saveRestoring(file, manifest.settings.originalText);
    else saveOrRemove(file, created && !remaining.length);
  }
  if (!remaining.length) {
    if (manifest.settings.excludeAdded) unexcludeLocally(root, relative(root, path));
    if (manifest.settings.claudeDirCreated) removeIfEmpty(dirname(path));
    manifest.settings = undefined;
  }
  saveManifest(root, manifest);
  finishManifest(root, plan.scope, remaining);
  return { remaining };
}

function finishManifest(root: string, scope: SettingsScope, remaining: HookFeature[]): void {
  const m = loadManifest(root, CODEX_ID, scope);
  if (!m) return;
  m.features = remaining;
  if (!remaining.length && !m.settings && !m.block && !m.files.length) deleteManifest(root, CODEX_ID, scope);
  else saveManifest(root, m);
}

export function removeIfEmpty(dir: string): void {
  try {
    if (isDir(dir) && readdirSync(dir).length === 0) remove(dir);
  } catch {
    // leave it
  }
}

/** Files an apply_patch edit touches: added, updated, deleted, and moved-to paths. */
export function patchFiles(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    const m = /^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/.exec(line) ?? /^\*\*\* Move to: (.+?)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return [...new Set(out)];
}

/**
 * The script a shell tool call runs. Codex may give it as a string or as an
 * argument list, and may wrap it in `bash -lc '…'`.
 */
export function shellScript(command: unknown): string {
  let s = Array.isArray(command) ? command.map(String) : undefined;
  if (s && s.length >= 3 && /(^|\/)(ba|z)?sh$/.test(s[0]) && /^-[a-z]*c[a-z]*$/.test(s[1])) return s[2];
  if (s) return s.map((w) => (/[\s"'$`\\|&;<>()]/.test(w) ? `'${w.replace(/'/g, `'\\''`)}'` : w)).join(" ");
  const text = typeof command === "string" ? command : "";
  const parts = splitCommand(text);
  if (parts?.length === 1) {
    const w = parts[0].words;
    if (w.length === 3 && /(^|\/)(ba|z)?sh$/.test(w[0]) && /^-[a-z]*c[a-z]*$/.test(w[1])) return w[2];
  }
  return text;
}

export const codexDialect: HookDialect = {
  toolCall(input) {
    const tool = input.tool_name ?? "";
    const ti = input.tool_input ?? {};
    // Codex reports every file edit as apply_patch; Edit and Write only as matcher aliases.
    if (tool === "apply_patch" || tool === "Edit" || tool === "Write") {
      const text = typeof ti.command === "string" ? ti.command : typeof ti.patch === "string" ? ti.patch : typeof ti.input === "string" ? ti.input : "";
      const files = patchFiles(text);
      if (!files.length && typeof ti.file_path === "string") files.push(ti.file_path);
      return { kind: "edit", files };
    }
    if (tool === "Bash" || tool === "shell" || tool === "exec_command") return { kind: "shell", command: shellScript(ti.command ?? ti.cmd) };
    return { kind: "other" };
  },
  updateHelper: `Hand the note and this plan to the cube-updater agent (a custom agent in .codex/agents/: spawn it as a subagent and give it both).`,
  personRuns(cmd) {
    return `Ask the person to run it themselves, in a terminal in this project: ${cmd}`;
  },
  personPrompt: "rules",
};

/** The person-only commands Codex's rules make ask, in the exact form an agent must use for the rule to catch them. */
export const PERSON_ONLY_VERBS = [["approve"], ["reject"], ["restore"], ["replace"], ["delete"], ["config", "set"]];

/** The tool's words as the rules match them: `node context-cube/.tool/cube.mjs`. */
export const TOOL_WORDS = TOOL_COMMAND.split(" ");
