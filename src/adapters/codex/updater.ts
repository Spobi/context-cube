import { join } from "node:path";
import { exists, isDir, remove, writeIfChanged } from "../../core/fsutil";
import { emptyManifest, loadManifest, saveManifest } from "../../core/installs";
import { TOOL_COMMAND } from "../../core/paths";
import type { UpdaterSpec } from "../types";
import { CODEX_ID, removeIfEmpty } from "./hooks";

/**
 * The note-plus-helper split for Codex: a custom agent (.codex/agents/*.toml)
 * does the mechanical updates at low reasoning effort, and a skill
 * (.agents/skills/cube-update/SKILL.md) is the manual trigger, as /cube-update
 * is in Claude Code. The helper keeps the session's model: model names differ
 * between Codex plans and change often, so none is written here.
 */

export const AGENT_FILE = ".codex/agents/cube-updater.toml";
export const SKILL_FILE = ".agents/skills/cube-update/SKILL.md";

/** A TOML string: a literal multi-line one, which needs no escapes, when the text allows it. */
function tomlString(s: string): string {
  if (!s.includes("'''")) return `'''\n${s}\n'''`;
  return JSON.stringify(s);
}

export function updaterAgent(spec: UpdaterSpec): string {
  return [
    "# Written by Context Cube: the helper that keeps the project memory (context-cube/) current.",
    `name = "cube-updater"`,
    `description = ${JSON.stringify(spec.description)}`,
    `model_reasoning_effort = "low"`,
    `sandbox_mode = "workspace-write"`,
    `developer_instructions = ${tomlString(spec.prompt)}`,
    "",
  ].join("\n");
}

export function updateSkill(): string {
  return `---
name: cube-update
description: Update the project's Context Cube (the project memory in context-cube/) for the work done in this session. Use after a commit, or when asked to update the cube or the project memory.
---
Update the project memory (Context Cube) for the work done in this session.

1. Run \`${TOOL_COMMAND} update-plan --agent codex\` to see which boxes are linked to what changed and which commands to use.
2. Write a short note (2–4 sentences): what changed and why.
3. Hand the note and the plan to the cube-updater agent (the custom agent in .codex/agents/cube-updater.toml). It does the mechanical updates. If you can't start it, follow the plan yourself.
4. If the helper reports a possible new invariant, propose it with \`${TOOL_COMMAND} propose new ...\`; a person approves it.
`;
}

export function installCodexUpdater(root: string, spec: UpdaterSpec): void {
  const manifest = loadManifest(root, CODEX_ID, "shared") ?? emptyManifest(CODEX_ID, "shared");
  const dirs = new Set(manifest.dirs);
  for (const d of [".codex", ".codex/agents", ".agents", ".agents/skills", ".agents/skills/cube-update"]) if (!isDir(join(root, d))) dirs.add(d);
  const files = new Set(manifest.files);
  for (const [rel, text] of [
    [AGENT_FILE, updaterAgent(spec)],
    [SKILL_FILE, updateSkill()],
  ] as const) {
    if (!exists(join(root, rel))) files.add(rel);
    writeIfChanged(join(root, rel), text);
  }
  manifest.files = [...files];
  manifest.dirs = [...dirs];
  saveManifest(root, manifest);
}

export function uninstallCodexUpdater(root: string): void {
  const manifest = loadManifest(root, CODEX_ID, "shared");
  if (!manifest) return;
  for (const f of manifest.files.filter((x) => x === AGENT_FILE || x === SKILL_FILE)) remove(join(root, f));
  manifest.files = manifest.files.filter((x) => x !== AGENT_FILE && x !== SKILL_FILE);
  // Deepest first, and only folders this install made.
  for (const d of [".agents/skills/cube-update", ".agents/skills", ".agents", ".codex/agents"]) {
    if (manifest.dirs.includes(d)) removeIfEmpty(join(root, d));
  }
  saveManifest(root, manifest);
}
