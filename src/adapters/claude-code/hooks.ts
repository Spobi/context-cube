import { dirname, isAbsolute, join, relative } from "node:path";
import { exists, isDir, readTextOr, remove, writeText } from "../../core/fsutil";
import { git, gitRoot } from "../../core/git";
import { cubePaths } from "../../core/paths";
import { deleteManifest, emptyManifest, loadManifest, saveManifest } from "../../core/installs";
import type { HookFeature, HookPlan, SettingsScope } from "../types";
import { addHooks, loadSettings, readRaw, removeHooks, saveOrRemove, saveRestoring, settingsPath, type HookEntry } from "./settings";
import { readdirSync } from "node:fs";

export const ADAPTER_ID = "claude-code";

interface EventSpec {
  event: string;
  cli: string;
  matchers?: string[];
  timeout: number;
}

const FEATURE_EVENTS: Record<HookFeature, EventSpec[]> = {
  log: [
    { event: "PostToolUse", cli: "post-tool-use", matchers: ["Read", "Grep", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"], timeout: 10 },
    { event: "InstructionsLoaded", cli: "instructions-loaded", timeout: 10 },
    { event: "SessionStart", cli: "session-start", timeout: 10 },
    { event: "SessionEnd", cli: "session-end", timeout: 10 },
  ],
  session: [{ event: "SessionStart", cli: "session-start", timeout: 10 }],
  guard: [{ event: "PreToolUse", cli: "pre-tool-use", matchers: ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"], timeout: 10 }],
  update: [
    { event: "PostToolUse", cli: "post-tool-use", matchers: ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"], timeout: 10 },
    { event: "Stop", cli: "stop", timeout: 10 },
  ],
};

/** Recognizes hook commands this tool installed. */
export function isOurHookCommand(command: string): boolean {
  return /context-cube\/\.tool\/cube\.mjs"? hook /.test(command);
}

function toolRef(root: string, scope: SettingsScope): string {
  // Personal settings are machine-specific, so an absolute path is safest there.
  // Shared settings must work on every teammate's machine.
  if (scope === "local") return `"${cubePaths(root).toolFile}"`;
  return `"$CLAUDE_PROJECT_DIR"/context-cube/.tool/cube.mjs`;
}

/** Builds one hook entry per event, combining every feature that uses the event. */
export function hookEntries(root: string, scope: SettingsScope, features: HookFeature[]): HookEntry[] {
  const byEvent = new Map<string, { spec: EventSpec; features: Set<HookFeature>; matchers: Set<string> | undefined }>();
  for (const f of features) {
    for (const spec of FEATURE_EVENTS[f]) {
      const cur = byEvent.get(spec.event) ?? { spec, features: new Set(), matchers: spec.matchers ? new Set() : undefined };
      cur.features.add(f);
      if (spec.matchers && cur.matchers) spec.matchers.forEach((m) => cur.matchers!.add(m));
      byEvent.set(spec.event, cur);
    }
  }
  const ref = toolRef(root, scope);
  return [...byEvent.values()].map(({ spec, features: fs, matchers }) => ({
    event: spec.event,
    matcher: matchers ? [...matchers].join("|") : undefined,
    command: `node ${ref} hook ${spec.cli} --features ${[...fs].sort().join(",")}`,
    timeout: spec.timeout,
  }));
}

/**
 * Installs hooks for the given features. Our existing entries in the same
 * settings file are replaced by one combined set, so reinstalling is safe.
 */
export function installHooks(root: string, plan: HookPlan): { settingsFile: string; features: string[] } {
  const manifest = loadManifest(root, ADAPTER_ID, plan.scope) ?? emptyManifest(ADAPTER_ID, plan.scope);
  const features = [...new Set([...manifest.features, ...plan.features])].sort() as HookFeature[];
  const path = settingsPath(root, plan.scope);
  const claudeDir = dirname(path);
  const claudeDirExisted = isDir(claudeDir);
  const originalText = manifest.settings ? manifest.settings.originalText : readRaw(path);
  const file = loadSettings(path);
  removeHooks(file.data, isOurHookCommand, manifest.settings ? { hooksKey: manifest.settings.hooksKey, events: manifest.settings.events } : undefined);
  const added = addHooks(file.data, hookEntries(root, plan.scope, features));
  const prev = manifest.settings;
  manifest.settings = {
    path: relative(root, path),
    created: prev ? prev.created : !file.existed,
    claudeDirCreated: prev ? prev.claudeDirCreated : !claudeDirExisted,
    hooksKey: prev ? prev.hooksKey || added.hooksKey : added.hooksKey,
    events: [...new Set([...(prev?.events ?? []), ...added.events])],
    permissions: prev?.permissions,
    originalText,
    excludeAdded: prev?.excludeAdded,
  };
  manifest.features = features;
  saveOrRemove(file, false);
  // Personal settings hold machine-specific paths; keep them out of git as Claude Code does.
  if (plan.scope === "local" && !manifest.settings.excludeAdded) manifest.settings.excludeAdded = excludeLocally(root, relative(root, path));
  saveManifest(root, manifest);
  return { settingsFile: path, features };
}

/** Adds a path to .git/info/exclude (never committed) if git doesn't already ignore it. */
export function excludeLocally(root: string, rel: string): boolean {
  if (!gitRoot(root)) return false;
  if (git(["check-ignore", "-q", rel], root).ok) return false;
  const excludePath = git(["rev-parse", "--git-path", "info/exclude"], root).stdout.trim();
  const abs = isAbsolute(excludePath) ? excludePath : join(root, excludePath);
  const text = readTextOr(abs, "");
  writeText(abs, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${rel}\n`);
  return true;
}

export function unexcludeLocally(root: string, rel: string): void {
  if (!gitRoot(root)) return;
  const excludePath = git(["rev-parse", "--git-path", "info/exclude"], root).stdout.trim();
  const abs = isAbsolute(excludePath) ? excludePath : join(root, excludePath);
  const text = readTextOr(abs, "");
  const next = text.split("\n").filter((l) => l !== rel).join("\n");
  if (next !== text) writeText(abs, next);
}

/** Removes the given features' hooks, keeping any other features installed in the same file. */
export function uninstallHooks(root: string, plan: HookPlan): { remaining: string[] } {
  const manifest = loadManifest(root, ADAPTER_ID, plan.scope);
  const path = settingsPath(root, plan.scope);
  const remaining = (manifest?.features ?? []).filter((f) => !plan.features.includes(f as HookFeature)) as HookFeature[];
  if (!exists(path)) {
    if (manifest) finishManifest(root, plan.scope, remaining);
    return { remaining };
  }
  const file = loadSettings(path);
  const containers = manifest?.settings ? { hooksKey: manifest.settings.hooksKey, events: manifest.settings.events } : undefined;
  removeHooks(file.data, isOurHookCommand, remaining.length ? { hooksKey: false, events: [] } : containers);
  if (remaining.length) {
    addHooks(file.data, hookEntries(root, plan.scope, remaining));
    // Events this tool added that no remaining feature uses: don't leave them empty.
    for (const e of manifest?.settings?.events ?? []) if (Array.isArray(file.data.hooks?.[e]) && !file.data.hooks[e].length) delete file.data.hooks[e];
  }
  const created = manifest?.settings?.created ?? false;
  const permsLeft = manifest?.settings?.permissions?.rules.length ?? 0;
  if (!remaining.length && !permsLeft && !created) saveRestoring(file, manifest?.settings?.originalText);
  else saveOrRemove(file, created && !remaining.length && !permsLeft);
  if (!remaining.length && !permsLeft && manifest?.settings?.excludeAdded) unexcludeLocally(root, relative(root, path));
  if (!remaining.length && !permsLeft && manifest?.settings?.claudeDirCreated) {
    const dir = dirname(path);
    if (isDir(dir) && readdirSync(dir).length === 0) remove(dir);
  }
  if (manifest) finishManifest(root, plan.scope, remaining);
  return { remaining };
}

function finishManifest(root: string, scope: SettingsScope, remaining: HookFeature[]): void {
  const m = loadManifest(root, ADAPTER_ID, scope);
  if (!m) return;
  m.features = remaining;
  const empty = !remaining.length && !m.settings?.permissions?.rules.length && !m.block && !m.files.length;
  if (empty) deleteManifest(root, ADAPTER_ID, scope);
  else saveManifest(root, m);
}

export function claudeDirOf(root: string): string {
  return join(root, ".claude");
}
