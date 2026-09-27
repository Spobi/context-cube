import { join } from "node:path";
import { exists, isDir } from "../../core/fsutil";
import type { AgentAdapter, AICall, AIResult, HookDialect, HookPlan, PathRule, PermissionRule, UpdaterSpec } from "../types";
import { ADAPTER_ID, installHooks, uninstallHooks } from "./hooks";
import { removeInstructionBlock, writeInstructionBlock } from "../shared/instructionBlock";
import { findClaude, hasClaudeDesktop, inClaudeDesktop } from "./bin";

let pathRulesImpl: typeof import("./pathRules") | undefined;
let permissionsImpl: typeof import("./permissions") | undefined;
let updaterImpl: typeof import("./updater") | undefined;
let runnerImpl: typeof import("./runner") | undefined;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export const claudeDialect: HookDialect = {
  toolCall(input) {
    const tool = input.tool_name ?? "";
    const ti = input.tool_input ?? {};
    if (EDIT_TOOLS.has(tool)) {
      const file = String(ti.file_path ?? ti.notebook_path ?? "");
      return { kind: "edit", files: file ? [file] : [] };
    }
    if (tool === "Bash") return { kind: "shell", command: String(ti.command ?? "") };
    return { kind: "other" };
  },
  updateHelper: `Hand the note and this plan to the cube-updater agent (a helper on a cheap model), for example with the Task tool and subagent_type "cube-updater".`,
  personRuns(cmd) {
    // The desktop app has no \`!\` prefix, but it has a terminal pane.
    if (inClaudeDesktop()) return `Ask the person to run it themselves, in a terminal in this project (the desktop app has one: the Views menu, or Ctrl+\`): ${cmd}`;
    return `Ask the person to run it themselves (in Claude Code they can type: ! ${cmd})`;
  },
  personPrompt: "ask",
};

export const claudeCodeAdapter: AgentAdapter = {
  id: ADAPTER_ID,
  name: "Claude Code",
  hookDialect: claudeDialect,
  capabilities: {
    hooks: true,
    blockEdits: true,
    pathRules: true,
    subagents: true,
    nonInteractive: true,
    permissionPrompts: true,
  },
  async detect(projectRoot: string) {
    if (isDir(join(projectRoot, ".claude")) || exists(join(projectRoot, "CLAUDE.md"))) return true;
    return !!findClaude() || hasClaudeDesktop();
  },
  async writeAlwaysLoadedBlock(projectRoot: string, block: string) {
    writeInstructionBlock(projectRoot, ADAPTER_ID, "CLAUDE.md", block);
  },
  async removeAlwaysLoadedBlock(projectRoot: string) {
    removeInstructionBlock(projectRoot, ADAPTER_ID);
  },
  async installHooks(projectRoot: string, plan: HookPlan) {
    installHooks(projectRoot, plan);
  },
  async uninstallHooks(projectRoot: string, plan: HookPlan) {
    uninstallHooks(projectRoot, plan);
  },
  async installPathRules(projectRoot: string, rules: PathRule[]) {
    pathRulesImpl ??= await import("./pathRules");
    pathRulesImpl.installPathRules(projectRoot, rules);
  },
  async installPermissions(projectRoot: string, rules: PermissionRule[]) {
    permissionsImpl ??= await import("./permissions");
    permissionsImpl.installPermissions(projectRoot, rules);
  },
  async installUpdater(projectRoot: string, spec: UpdaterSpec) {
    updaterImpl ??= await import("./updater");
    updaterImpl.installUpdater(projectRoot, spec);
  },
  async runAI(call: AICall): Promise<AIResult> {
    runnerImpl ??= await import("./runner");
    return runnerImpl.runClaude(call);
  },
  async uninstall(projectRoot: string) {
    const { uninstallAll } = await import("./uninstall");
    await uninstallAll(projectRoot);
  },
};
