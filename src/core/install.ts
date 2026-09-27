import { loadConfig, saveConfig } from "./config";
import { adaptersFor } from "../adapters/registry";
import { reindex } from "./index/index";
import { hasHookBlock, hooksFolderTracked, installMergeHooks, installPreCommit, removeMergeHooks, removePreCommit } from "./gitHooks";
import { installMergeDrivers, removeMergeDrivers } from "./merge";
import { git, gitRoot } from "./git";
import { TOOL_COMMAND } from "./paths";
import { writeSearchIgnore } from "./tool";
import { loadManifest } from "./installs";
import { UPDATER_PROMPT } from "../adapters/claude-code/updater";
import type { HookFeature, PermissionRule } from "../adapters/types";

/** The hook features a built cube uses. The read logger ("log") is separate and optional. */
export const CUBE_FEATURES: HookFeature[] = ["guard", "session", "update"];

/** Commands that must always ask a person (plan 9.3), and the archive, which the agent doesn't read. */
export const PERSON_ONLY_RULES: PermissionRule[] = [
  ...["config set", "approve", "reject", "restore", "replace"].map((c) => ({ rule: `Bash(${TOOL_COMMAND} ${c}:*)`, behavior: "ask" as const })),
  { rule: "Read(/context-cube/.state/archive/**)", behavior: "deny" },
];

/**
 * Installs the cube for each configured agent: the always-loaded block and
 * path rules (via index), then hooks, permission rules, and the updater helper
 * where the agent supports them, plus the git pre-commit check. Agents without
 * hooks still get a working cube as plain files (plan 4.1).
 */
export async function installAgents(root: string, features: HookFeature[] = CUBE_FEATURES, opts: { shared?: boolean } = {}): Promise<string[]> {
  if (opts.shared !== undefined) {
    const c = loadConfig(root);
    c.hooks.scope = opts.shared ? "shared" : "local";
    saveConfig(root, c);
  }
  const config = loadConfig(root);
  writeSearchIgnore(root);
  await reindex(root);
  const out: string[] = [];
  for (const a of adaptersFor(config.agents)) {
    if (!a.capabilities.hooks) {
      out.push(`${a.id}: the always-loaded block is written; this agent has no hooks, so there's no automatic checking or updating.`);
      continue;
    }
    // Moving between personal and shared settings: the cube's hooks leave the other file (a logger there stays).
    // Only if they're there: a file the cube never touched stays exactly as it is.
    const other = config.hooks.scope === "local" ? "shared" : "local";
    if (loadManifest(root, a.id, other)?.features.some((f) => CUBE_FEATURES.includes(f as HookFeature))) {
      await a.uninstallHooks(root, { features: CUBE_FEATURES, scope: other });
    }
    await a.installHooks(root, { features, scope: config.hooks.scope });
    if (a.capabilities.permissionPrompts) await a.installPermissions(root, PERSON_ONLY_RULES);
    if (a.capabilities.subagents) await a.installUpdater(root, { description: "Updates the project's Context Cube (project memory) from a short note about a change. Use right after a commit, or when asked to update the cube.", prompt: UPDATER_PROMPT, tier: "haiku" });
    out.push(`${a.id}: hooks (${features.join(", ")}) in ${config.hooks.scope === "local" ? "your personal settings" : "the shared project settings"}; the cube-updater helper and /cube-update command in .claude/.`);
  }
  const hook = installPreCommit(root);
  if (hook) {
    installMergeHooks(root);
    installMergeDrivers(root);
    out.push(`git: a pre-commit check blocks commits that change invariant text without approval; after merges, duplicate numbers are fixed and generated files rebuilt.`);
  }
  return out;
}

/**
 * Sets up this clone for the cube, where it isn't yet: the merge drivers (they
 * live in each clone's git config, which can't be committed), the pre-commit
 * check, and renumbering after merges. Runs at the start of each session, so a
 * teammate who only pulled gets them. A hooks folder the project tracks in git
 * (husky and the like) is left alone: changing it would change the project.
 * Returns what it set up.
 */
export function setUpClone(root: string): string[] {
  if (!gitRoot(root)) return [];
  const done: string[] = [];
  if (!git(["config", "--get", "merge.cube-generated.driver"], root).stdout.trim()) {
    installMergeDrivers(root);
    done.push("merge drivers");
  }
  if (!hooksFolderTracked(root)) {
    if (!hasHookBlock(root, "pre-commit") && installPreCommit(root)) done.push("the pre-commit check for invariant text");
    if (!hasHookBlock(root, "post-merge")) {
      installMergeHooks(root);
      done.push("renumbering after merges");
    }
  }
  return done;
}

export async function uninstallAgents(root: string): Promise<string[]> {
  const config = loadConfig(root);
  for (const a of adaptersFor(config.agents)) await a.uninstall(root);
  removePreCommit(root);
  removeMergeHooks(root);
  if (gitRoot(root)) removeMergeDrivers(root);
  return [
    "Removed the always-loaded block, hooks, permission rules, path rules, the updater helper, and the pre-commit check.",
    "The cube itself (context-cube/) is still here. If you don't want it, first put your original files back (" + TOOL_COMMAND + " restore --all), since their archived copies live inside it; then delete the folder.",
    "The read logger, if installed, is removed with: cube log uninstall",
  ];
}
