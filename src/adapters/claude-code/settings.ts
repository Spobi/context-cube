import { join } from "node:path";
import type { SettingsScope } from "../types";

export * from "../shared/jsonSettings";

/** Claude Code's settings file for a scope: personal (settings.local.json) or shared (settings.json). */
export function settingsPath(root: string, scope: SettingsScope): string {
  return join(root, ".claude", scope === "local" ? "settings.local.json" : "settings.json");
}
