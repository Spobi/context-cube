import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { exists, isDir } from "../../core/fsutil";
import type { AgentAdapter, AICall, AIResult, HookPlan, PathRule, PermissionRule, UpdaterSpec } from "../types";
import { ADAPTER_ID, installHooks, uninstallHooks } from "./hooks";
import { removeInstructionBlock, writeInstructionBlock } from "../shared/instructionBlock";

let pathRulesImpl: typeof import("./pathRules") | undefined;
let permissionsImpl: typeof import("./permissions") | undefined;
let updaterImpl: typeof import("./updater") | undefined;
let runnerImpl: typeof import("./runner") | undefined;

export const claudeCodeAdapter: AgentAdapter = {
  id: ADAPTER_ID,
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
    const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
    return r.status === 0;
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
