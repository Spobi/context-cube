import { loadConfig } from "../../core/config";
import { emptyManifest, loadManifest, saveManifest } from "../../core/installs";
import type { PermissionRule } from "../types";
import { ADAPTER_ID } from "./hooks";
import { addPermissions, loadSettings, removePermissions, saveOrRemove, saveRestoring, settingsPath } from "./settings";

/**
 * Permission rules (plan 9.3): `cube config set`, `approve`, and `reject`
 * always ask the person, even if they auto-approve other commands. The guard
 * hook asks too (and blocks in modes that skip prompts); these rules are the
 * second layer.
 */
export function installPermissions(root: string, rules: PermissionRule[]): void {
  const scope = loadConfig(root).hooks.scope;
  // Moving between personal and shared settings: take ours out of the other file first.
  const other = scope === "local" ? "shared" : "local";
  const theirs = loadManifest(root, ADAPTER_ID, other);
  if (theirs?.settings?.permissions) {
    const otherFile = loadSettings(settingsPath(root, other));
    removePermissions(otherFile.data, theirs.settings.permissions);
    theirs.settings.permissions = undefined;
    saveOrRemove(otherFile, !!theirs.settings.created && !theirs.features.length);
    saveManifest(root, theirs);
  }
  const path = settingsPath(root, scope);
  const manifest = loadManifest(root, ADAPTER_ID, scope) ?? emptyManifest(ADAPTER_ID, scope);
  const file = loadSettings(path);
  const prev = manifest.settings?.permissions;
  const added = addPermissions(file.data, rules);
  manifest.settings = manifest.settings ?? { path: path.slice(root.length + 1), created: !file.existed, claudeDirCreated: false, hooksKey: false, events: [] };
  manifest.settings.permissions = {
    permissionsKey: prev ? prev.permissionsKey || added.permissionsKey : added.permissionsKey,
    lists: [...new Set([...(prev?.lists ?? []), ...added.lists])],
    rules: [...(prev?.rules ?? []), ...added.rules],
  };
  saveOrRemove(file, false);
  saveManifest(root, manifest);
}

export function uninstallPermissions(root: string): void {
  for (const scope of ["local", "shared"] as const) {
    const manifest = loadManifest(root, ADAPTER_ID, scope);
    const perms = manifest?.settings?.permissions;
    if (!manifest || !perms) continue;
    const path = settingsPath(root, scope);
    const file = loadSettings(path);
    removePermissions(file.data, perms);
    manifest.settings!.permissions = undefined;
    const nothingLeft = !manifest.features.length;
    if (nothingLeft && !manifest.settings!.created) saveRestoring(file, manifest.settings!.originalText);
    else saveOrRemove(file, !!manifest.settings!.created && nothingLeft);
    saveManifest(root, manifest);
  }
}
