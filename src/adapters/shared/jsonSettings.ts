import { exists, readText, remove, writeText } from "../../core/fsutil";

/**
 * Edits an agent's JSON settings or hooks file (Claude Code's settings.json,
 * Codex's hooks.json) while keeping the rest of the file as it was: same
 * indentation, same trailing newline, other keys untouched. Removing what we
 * added returns the file to its original bytes.
 */

export interface SettingsFile {
  path: string;
  existed: boolean;
  data: Record<string, any>;
  indent: string;
  trailingNewline: boolean;
}

export function readRaw(path: string): string | undefined {
  return exists(path) ? readText(path) : undefined;
}

/** True when two JSON values are the same data (key order ignored). */
export function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as any)[k])]));
    }
    return v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** Writes `originalText` back when the data matches it, so an uninstall leaves the original bytes. */
export function saveRestoring(file: SettingsFile, originalText: string | undefined): void {
  if (originalText !== undefined) {
    try {
      if (sameJson(file.data, originalText.trim() ? JSON.parse(originalText) : {})) {
        writeText(file.path, originalText);
        return;
      }
    } catch {
      // fall through
    }
  }
  saveSettings(file);
}

export function loadSettings(path: string): SettingsFile {
  if (!exists(path)) return { path, existed: false, data: {}, indent: "  ", trailingNewline: true };
  const text = readText(path);
  const data = text.trim() ? JSON.parse(text) : {};
  const m = /\n([ \t]+)"/.exec(text);
  return {
    path,
    existed: true,
    data,
    indent: m ? m[1] : "  ",
    trailingNewline: text.endsWith("\n"),
  };
}

export function saveSettings(file: SettingsFile): void {
  const text = JSON.stringify(file.data, null, file.indent);
  writeText(file.path, file.trailingNewline ? `${text}\n` : text);
}

/** Deletes the settings file if we created it and it's now empty. */
export function saveOrRemove(file: SettingsFile, createdByUs: boolean): void {
  if (createdByUs && Object.keys(file.data).length === 0) {
    remove(file.path);
    return;
  }
  saveSettings(file);
}

export interface HookEntry {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
}

export interface AddedContainers {
  /** True if we created the top-level "hooks" object. */
  hooksKey: boolean;
  /** Events whose arrays we created. */
  events: string[];
}

export function addHooks(data: Record<string, any>, entries: HookEntry[]): AddedContainers {
  const added: AddedContainers = { hooksKey: false, events: [] };
  if (!data.hooks || typeof data.hooks !== "object") {
    data.hooks = {};
    added.hooksKey = true;
  }
  for (const e of entries) {
    if (!Array.isArray(data.hooks[e.event])) {
      data.hooks[e.event] = [];
      added.events.push(e.event);
    }
    const groups: any[] = data.hooks[e.event];
    const already = groups.some((g) => (g.hooks ?? []).some((h: any) => h.command === e.command));
    if (already) continue;
    const handler: Record<string, unknown> = { type: "command", command: e.command };
    if (e.timeout) handler.timeout = e.timeout;
    const group: Record<string, unknown> = {};
    if (e.matcher) group.matcher = e.matcher;
    group.hooks = [handler];
    groups.push(group);
  }
  return added;
}

/**
 * Removes hook handlers whose command matches `isOurs`. Containers are removed
 * when they become empty and we created them (or when `added` is unknown).
 */
export function removeHooks(data: Record<string, any>, isOurs: (command: string) => boolean, added?: AddedContainers): number {
  let removed = 0;
  if (!data.hooks || typeof data.hooks !== "object") return 0;
  for (const event of Object.keys(data.hooks)) {
    const groups = data.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept: any[] = [];
    for (const g of groups) {
      const hooks: any[] = Array.isArray(g.hooks) ? g.hooks : [];
      const keptHooks = hooks.filter((h) => !(typeof h.command === "string" && isOurs(h.command)));
      removed += hooks.length - keptHooks.length;
      if (keptHooks.length === hooks.length) kept.push(g);
      else if (keptHooks.length) kept.push({ ...g, hooks: keptHooks });
    }
    data.hooks[event] = kept;
    const weCreated = added ? added.events.includes(event) : true;
    if (kept.length === 0 && weCreated) delete data.hooks[event];
  }
  const weCreatedHooks = added ? added.hooksKey : true;
  if (Object.keys(data.hooks).length === 0 && weCreatedHooks) delete data.hooks;
  return removed;
}

export interface PermissionAdded {
  permissionsKey: boolean;
  lists: string[];
  rules: { behavior: string; rule: string }[];
}

export function addPermissions(data: Record<string, any>, rules: { behavior: "allow" | "ask" | "deny"; rule: string }[]): PermissionAdded {
  const added: PermissionAdded = { permissionsKey: false, lists: [], rules: [] };
  if (!data.permissions || typeof data.permissions !== "object") {
    data.permissions = {};
    added.permissionsKey = true;
  }
  for (const r of rules) {
    if (!Array.isArray(data.permissions[r.behavior])) {
      data.permissions[r.behavior] = [];
      added.lists.push(r.behavior);
    }
    const list: string[] = data.permissions[r.behavior];
    if (!list.includes(r.rule)) {
      list.push(r.rule);
      added.rules.push(r);
    }
  }
  return added;
}

export function removePermissions(data: Record<string, any>, added: PermissionAdded): void {
  if (!data.permissions) return;
  for (const r of added.rules) {
    const list = data.permissions[r.behavior];
    if (Array.isArray(list)) data.permissions[r.behavior] = list.filter((x: string) => x !== r.rule);
  }
  for (const l of added.lists) {
    if (Array.isArray(data.permissions[l]) && data.permissions[l].length === 0) delete data.permissions[l];
  }
  if (added.permissionsKey && Object.keys(data.permissions).length === 0) delete data.permissions;
}
