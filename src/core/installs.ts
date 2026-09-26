import { join } from "node:path";
import { exists, readJsonOr, remove, writeJson } from "./fsutil";
import { cubePaths } from "./paths";
import type { SettingsScope } from "../adapters/types";

/**
 * Install manifests record exactly what an install added, so uninstall can
 * remove exactly that. Personal (local) installs are recorded in .logs/, which
 * git ignores; shared installs in .state/, which is committed.
 */
export interface InstallManifest {
  adapter: string;
  scope: SettingsScope;
  features: string[];
  /** Settings file (relative to the root) and which containers we created in it. */
  settings?: {
    path: string;
    created: boolean;
    claudeDirCreated: boolean;
    /** The file's exact text before our first change, restored when we remove everything we added. */
    originalText?: string;
    /** True when we added the file to .git/info/exclude. */
    excludeAdded?: boolean;
    hooksKey: boolean;
    events: string[];
    permissions?: { permissionsKey: boolean; lists: string[]; rules: { behavior: string; rule: string }[] };
  };
  /** Files we created (relative to the root). Removed on uninstall. */
  files: string[];
  /** Folders we created (relative to the root). Removed on uninstall if empty. */
  dirs: string[];
  /** The always-loaded block, if this install wrote one. */
  block?: { file: string; sep: string; created: boolean };
}

export function manifestPath(root: string, adapter: string, scope: SettingsScope): string {
  const p = cubePaths(root);
  return scope === "local" ? join(p.logs, "install", `${adapter}-local.json`) : join(p.state, "install", `${adapter}-shared.json`);
}

export function loadManifest(root: string, adapter: string, scope: SettingsScope): InstallManifest | undefined {
  const path = manifestPath(root, adapter, scope);
  if (!exists(path)) return undefined;
  return readJsonOr<InstallManifest | undefined>(path, undefined);
}

export function saveManifest(root: string, m: InstallManifest): void {
  writeJson(manifestPath(root, m.adapter, m.scope), m);
}

export function deleteManifest(root: string, adapter: string, scope: SettingsScope): void {
  remove(manifestPath(root, adapter, scope));
}

export function emptyManifest(adapter: string, scope: SettingsScope): InstallManifest {
  return { adapter, scope, features: [], files: [], dirs: [] };
}
