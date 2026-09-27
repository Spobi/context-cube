import { join } from "node:path";
import { homedir } from "node:os";
import { isDir } from "../../core/fsutil";
import { deleteManifest, loadManifest } from "../../core/installs";
import type { AgentAdapter, HookDialect } from "../types";
import { splitCommand } from "../../core/logs/shell";
import { removeInstructionBlock, writeInstructionBlock } from "../shared/instructionBlock";
import { onPathBin } from "../claude-code/bin";
import { CODEX_ID, codexDialect, installCodexHooks, PERSON_ONLY_VERBS, removeIfEmpty, TOOL_WORDS, uninstallCodexHooks } from "./hooks";
import { codexRulesInstalled, installCodexRules, uninstallCodexRules } from "./rules";
import { installCodexUpdater, uninstallCodexUpdater } from "./updater";

/**
 * Codex (OpenAI's coding agent) reads the cube: the always-loaded block in
 * AGENTS.md, which Codex loads at the start of every session, and hooks for
 * the guard, the session notice, and updates. Codex has no path-scoped rule
 * files, so the guard hook tells the agent which invariants govern a file when
 * it edits or reads one (see handlers.ts). Building a cube still needs Claude
 * Code: Codex can't run the build's AI steps yet.
 */

/** Is Codex on this machine (the CLI, or the folder its app and editor extensions keep)? */
export function codexOnMachine(): boolean {
  // "0" or "1" overrides the check (tests, and anyone who wants setup to leave Codex out).
  if (process.env.CUBE_CODEX) return process.env.CUBE_CODEX === "1";
  return !!onPathBin("codex") || isDir(join(homedir(), ".codex"));
}

/** Is this process running inside a Codex session (a command Codex ran)? */
export function inCodexSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID);
}

/**
 * Codex's rules match a command's leading words, so they catch a person-only
 * command only when it is one plain command starting `node
 * context-cube/.tool/cube.mjs <verb>`, nothing chained before or after it.
 */
export function ruleShaped(cmd: string): boolean {
  const parts = splitCommand(cmd.trim());
  if (!parts || parts.length !== 1) return false;
  const words = parts[0].words;
  return PERSON_ONLY_VERBS.some((verb) => [...TOOL_WORDS, ...verb].every((w, i) => words[i] === w));
}

const dialect: HookDialect = {
  ...codexDialect,
  rulesWillAsk: (root, cmd) => ruleShaped(cmd) && codexRulesInstalled(root),
};

export const codexAdapter: AgentAdapter = {
  id: CODEX_ID,
  name: "Codex",
  hookDialect: dialect,
  capabilities: {
    hooks: true,
    blockEdits: true,
    // Emulated by the guard hook, which needs nothing installed for it.
    pathRules: false,
    subagents: true,
    nonInteractive: false,
    permissionPrompts: true,
  },
  async detect(projectRoot: string) {
    return isDir(join(projectRoot, ".codex")) || codexOnMachine();
  },
  async writeAlwaysLoadedBlock(projectRoot, block) {
    writeInstructionBlock(projectRoot, CODEX_ID, "AGENTS.md", block);
  },
  async removeAlwaysLoadedBlock(projectRoot) {
    removeInstructionBlock(projectRoot, CODEX_ID);
  },
  async installHooks(projectRoot, plan) {
    installCodexHooks(projectRoot, plan);
  },
  async uninstallHooks(projectRoot, plan) {
    uninstallCodexHooks(projectRoot, plan);
  },
  async installPathRules() {},
  async installPermissions(projectRoot) {
    installCodexRules(projectRoot);
  },
  async installUpdater(projectRoot, spec) {
    installCodexUpdater(projectRoot, spec);
  },
  async runAI() {
    throw new Error("Codex can't run the build's AI steps yet. Building a cube from existing files needs Claude Code (the CLI, or the Claude desktop app).");
  },
  async uninstall(projectRoot) {
    // Whichever part made .codex/ (the hooks, the rules, or the helper), it goes once it's empty.
    const made = (["local", "shared"] as const).some((scope) => {
      const m = loadManifest(projectRoot, CODEX_ID, scope);
      return !!m?.dirs.includes(".codex") || !!m?.settings?.claudeDirCreated;
    });
    for (const scope of ["local", "shared"] as const) {
      const m = loadManifest(projectRoot, CODEX_ID, scope);
      if (m?.features.length) uninstallCodexHooks(projectRoot, { features: m.features as any, scope });
    }
    uninstallCodexRules(projectRoot);
    uninstallCodexUpdater(projectRoot);
    removeInstructionBlock(projectRoot, CODEX_ID);
    if (made) removeIfEmpty(join(projectRoot, ".codex"));
    const shared = loadManifest(projectRoot, CODEX_ID, "shared");
    if (shared && !shared.features.length && !shared.files.length && !shared.block && !shared.settings) deleteManifest(projectRoot, CODEX_ID, "shared");
  },
};
