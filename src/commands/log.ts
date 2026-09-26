import { join, relative } from "node:path";
import { readdirSync } from "node:fs";
import { findProjectRoot, cubePaths } from "../core/paths";
import { installTool } from "../core/tool";
import { exists, isDir, remove } from "../core/fsutil";
import { defaultConfig, loadConfig, saveConfig } from "../core/config";
import { detectMemoryFiles } from "../core/logs/memoryFiles";
import { buildReport, renderReport } from "../core/logs/report";
import { loadReads, loadSessions, logFiles } from "../core/logs/store";
import { installHooks, uninstallHooks, ADAPTER_ID } from "../adapters/claude-code/hooks";
import { loadManifest, saveManifest, deleteManifest, manifestPath } from "../core/installs";
import type { SettingsScope } from "../adapters/types";
import { settingsPath } from "../adapters/claude-code/settings";
import { cubeHasRows } from "../core/cube";

export interface LogInstallOptions {
  shared?: boolean;
  cwd?: string;
  quiet?: boolean;
}

export function logInstall(opts: LogInstallOptions = {}): string[] {
  const root = findProjectRoot(opts.cwd);
  const scope: SettingsScope = opts.shared ? "shared" : "local";
  const p = cubePaths(root);
  const tool = installTool(root);
  const configCreated = !exists(p.config);
  const config = configCreated ? defaultConfig() : loadConfig(root);
  if (!config.memoryFiles) config.memoryFiles = detectMemoryFiles(root);
  if (!config.agents.includes(ADAPTER_ID)) config.agents = [...config.agents, ADAPTER_ID];
  saveConfig(root, config);
  const { settingsFile } = installHooks(root, { features: ["log"], scope });

  const manifest = loadManifest(root, ADAPTER_ID, scope)!;
  const rel = (abs: string) => relative(root, abs);
  const files = new Set(manifest.files);
  const dirs = new Set(manifest.dirs);
  if (tool.cubeDirCreated) dirs.add(rel(p.cube));
  if (tool.gitignoreCreated) files.add(rel(join(p.cube, ".gitignore")));
  if (tool.toolCreated) {
    files.add(rel(p.toolFile));
    dirs.add(rel(p.tool));
  }
  if (configCreated) files.add(rel(p.config));
  manifest.files = [...files];
  manifest.dirs = [...dirs];
  saveManifest(root, manifest);

  const lines = [
    `Read logger installed in ${root}`,
    `  hooks: ${rel(settingsFile)} (${scope === "local" ? "personal, not shared through git" : "shared through git"})`,
    `  logs:  ${rel(p.logs)}/ (never leaves this machine; git ignores it)`,
    `  memory files the report tracks (${config.memoryFiles.length}):`,
    ...config.memoryFiles.map((f) => `    ${f}`),
    "",
    "Start a new Claude Code session here and work as usual. Then run:",
    "  node context-cube/.tool/cube.mjs log report",
    "To change which files count as memory files:",
    '  node context-cube/.tool/cube.mjs config set memoryFiles "A.md,docs/B.md"',
  ];
  return lines;
}

export interface LogUninstallOptions {
  cwd?: string;
  deleteLogs?: boolean;
}

export function logUninstall(opts: LogUninstallOptions = {}): string[] {
  const root = findProjectRoot(opts.cwd);
  const p = cubePaths(root);
  const out: string[] = [];
  for (const scope of ["local", "shared"] as SettingsScope[]) {
    const manifest = loadManifest(root, ADAPTER_ID, scope);
    if (!manifest || !manifest.features.includes("log")) continue;
    const files = manifest.files;
    const dirs = manifest.dirs;
    // Clear the file list first so the hook uninstall can drop the manifest when it's empty.
    manifest.files = [];
    manifest.dirs = [];
    saveManifest(root, manifest);
    const { remaining } = uninstallHooks(root, { features: ["log"], scope });
    out.push(`Removed the read-logging hooks from ${relative(root, settingsPath(root, scope))}.`);
    const cubeInUse = cubeHasRows(root) || remaining.length > 0 || otherInstall(root, scope);
    if (cubeInUse) {
      if (files.length) out.push("Kept the tool and settings files, because the cube still uses them.");
      const m = loadManifest(root, ADAPTER_ID, scope);
      if (m) {
        m.files = files;
        m.dirs = dirs;
        saveManifest(root, m);
      }
    } else {
      for (const f of files) {
        if (exists(join(root, f))) {
          remove(join(root, f));
          out.push(`Removed ${f}`);
        }
      }
      deleteManifest(root, ADAPTER_ID, scope);
      pruneEmptyDir(join(p.logs, "install"));
      pruneEmptyDir(p.logs);
      for (const d of [...dirs].sort((a, b) => b.length - a.length)) pruneEmptyDir(join(root, d));
    }
  }
  if (!out.length) out.push("The read logger isn't installed here.");
  if (opts.deleteLogs) {
    const logs = logFiles(root);
    for (const f of [logs.reads, logs.sessions, logs.errors, logs.edits]) remove(f);
    pruneEmptyDir(join(p.logs, "install"));
    pruneEmptyDir(p.logs);
    pruneEmptyDir(p.cube);
    out.push("Deleted the read logs.");
  } else if (exists(logFiles(root).reads) || exists(logFiles(root).sessions)) {
    out.push(`Kept your logs in ${relative(root, p.logs)}/. Delete them with: cube log uninstall --delete-logs`);
  }
  return out;
}

function otherInstall(root: string, scope: SettingsScope): boolean {
  const other: SettingsScope = scope === "local" ? "shared" : "local";
  return exists(manifestPath(root, ADAPTER_ID, other));
}

function pruneEmptyDir(dir: string): void {
  if (isDir(dir) && readdirSync(dir).length === 0) remove(dir);
}

export function logReport(opts: { cwd?: string; json?: boolean } = {}): string {
  const root = findProjectRoot(opts.cwd);
  const config = loadConfig(root);
  const memoryFiles = config.memoryFiles ?? detectMemoryFiles(root);
  const report = buildReport(root, loadReads(root), loadSessions(root), memoryFiles);
  if (opts.json) return JSON.stringify(report, null, 2);
  return renderReport(report, config.tokens.charsPerToken);
}
