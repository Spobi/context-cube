import { z } from "zod";
import { cubePaths } from "./paths";
import { exists, readJson, writeJson } from "./fsutil";

export const PRESETS = ["economy", "balanced", "max"] as const;
export const HISTORY_UNITS = ["build", "release", "pr", "day", "commit", "session"] as const;
export const UPDATE_TRIGGERS = ["commit", "stop", "manual"] as const;

export const ConfigSchema = z.object({
  preset: z.enum(PRESETS).default("balanced"),
  invariants: z
    .object({ approval: z.enum(["required", "auto"]).default("required") })
    .default({ approval: "required" }),
  history: z
    .object({
      unit: z.enum(HISTORY_UNITS).optional(),
      /** For projects without history files: how many recent commits to build history from. */
      gitCommits: z.number().int().positive().default(400),
    })
    .default({ gitCommits: 400 }),
  update: z
    .object({ trigger: z.enum(UPDATE_TRIGGERS).default("commit") })
    .default({ trigger: "commit" }),
  agents: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
  memoryFiles: z.array(z.string()).optional(),
  tokens: z.object({ charsPerToken: z.number().positive().default(4) }).default({ charsPerToken: 4 }),
  rowIndex: z.object({ pageTokens: z.number().int().positive().default(3000) }).default({ pageTokens: 3000 }),
  limits: z
    .object({
      z0Words: z.number().int().positive().default(80),
      rootDrawerTokens: z.number().int().positive().default(1500),
      /** The always-loaded block's ceiling. Above it, the row list drops summaries, and `cube check` warns. */
      blockTokens: z.number().int().positive().default(3000),
      /** `cube check` warns when a box has more header links than this. */
      links: z.number().int().positive().default(8),
    })
    .default({ z0Words: 80, rootDrawerTokens: 1500, blockTokens: 3000, links: 8 }),
  ai: z.object({ parallel: z.number().int().positive().default(4) }).default({ parallel: 4 }),
  /** Where the cube's hooks go: personal settings (local) or the committed project settings (shared). */
  hooks: z.object({ scope: z.enum(["local", "shared"]).default("local") }).default({ scope: "local" }),
});

export type CubeConfig = z.infer<typeof ConfigSchema>;

export function defaultConfig(): CubeConfig {
  return ConfigSchema.parse({});
}

export function loadConfig(root: string): CubeConfig {
  const p = cubePaths(root).config;
  if (!exists(p)) return defaultConfig();
  return ConfigSchema.parse(readJson(p));
}

export function saveConfig(root: string, config: CubeConfig): void {
  writeJson(cubePaths(root).config, ConfigSchema.parse(config));
}

/** Settings people can read and change with `cube config`. */
export const SETTING_KEYS = [
  "preset",
  "invariants.approval",
  "history.unit",
  "history.gitCommits",
  "update.trigger",
  "agents",
  "sources",
  "memoryFiles",
  "tokens.charsPerToken",
  "rowIndex.pageTokens",
  "limits.z0Words",
  "limits.rootDrawerTokens",
  "limits.blockTokens",
  "limits.links",
  "ai.parallel",
  "hooks.scope",
] as const;

export function getSetting(config: CubeConfig, key: string): unknown {
  let cur: unknown = config;
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Parses a command-line value: JSON if it parses, comma lists for array settings, else a string. */
export function parseSettingValue(key: string, raw: string): unknown {
  const arrayKeys = new Set(["agents", "sources", "memoryFiles"]);
  try {
    const v = JSON.parse(raw);
    if (arrayKeys.has(key) && typeof v === "string") return [v];
    return v;
  } catch {
    if (arrayKeys.has(key)) return raw.split(",").map((s) => s.trim()).filter(Boolean);
    return raw;
  }
}

export function setSetting(config: CubeConfig, key: string, value: unknown): CubeConfig {
  if (!(SETTING_KEYS as readonly string[]).includes(key)) {
    throw new Error(`Unknown setting "${key}". Settings: ${SETTING_KEYS.join(", ")}`);
  }
  const next = structuredClone(config) as Record<string, unknown>;
  const parts = key.split(".");
  let cur = next;
  for (const part of parts.slice(0, -1)) {
    if (typeof cur[part] !== "object" || cur[part] === null) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
  const parsed = ConfigSchema.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid value for ${key}: ${issue?.message ?? "rejected"}`);
  }
  return parsed.data;
}
