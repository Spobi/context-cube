import type { AgentAdapter } from "../types";
import { removeInstructionBlock, writeInstructionBlock } from "../shared/instructionBlock";

export const GENERIC_ID = "generic";

/**
 * For agents without hooks: writes the always-loaded block into AGENTS.md.
 * The cube still works as plain files, without automatic logging, updating,
 * or enforcement.
 */
export const genericAdapter: AgentAdapter = {
  id: GENERIC_ID,
  name: "your agent",
  capabilities: {
    hooks: false,
    blockEdits: false,
    pathRules: false,
    subagents: false,
    nonInteractive: false,
    permissionPrompts: false,
  },
  async detect() {
    return true;
  },
  async writeAlwaysLoadedBlock(projectRoot, block) {
    writeInstructionBlock(projectRoot, GENERIC_ID, "AGENTS.md", block);
  },
  async removeAlwaysLoadedBlock(projectRoot) {
    removeInstructionBlock(projectRoot, GENERIC_ID);
  },
  async installHooks() {},
  async uninstallHooks() {},
  async installPathRules() {},
  async installPermissions() {},
  async installUpdater() {},
  async runAI() {
    throw new Error("The generic adapter can't run AI steps. Use an agent adapter that supports non-interactive mode, such as claude-code.");
  },
  async uninstall(projectRoot) {
    removeInstructionBlock(projectRoot, GENERIC_ID);
  },
};
