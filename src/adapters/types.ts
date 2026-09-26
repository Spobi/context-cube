/**
 * The agent adapter interface (plan 4.1). The core knows nothing about any
 * specific AI tool; everything agent-specific lives behind this interface.
 */

export type HookFeature =
  /** Log file reads and session summaries (Phase 0). */
  | "log"
  /** Block direct edits of invariant text and cube.config.json (Phase 6). */
  | "guard"
  /** Session-start notice about stale or needs-review boxes (Phase 5). */
  | "session"
  /** Ask for a cube update after commits, or at the end of work (Phase 6). */
  | "update";

export type SettingsScope = "local" | "shared";

export interface HookPlan {
  features: HookFeature[];
  /** local: personal, gitignored settings. shared: committed project settings. */
  scope: SettingsScope;
}

export interface PathRule {
  /** Unique file stem, e.g. "cube-Y02-X007". */
  id: string;
  /** Globs relative to the project root. */
  paths: string[];
  body: string;
}

export interface PermissionRule {
  /** e.g. "Bash(node context-cube/.tool/cube.mjs config set:*)" */
  rule: string;
  behavior: "allow" | "ask" | "deny";
}

export interface UpdaterSpec {
  /** Short description of what the cheap helper does. */
  description: string;
  /** The helper's instructions. */
  prompt: string;
  tier: Tier;
}

export type Tier = "haiku" | "sonnet" | "opus";

export interface AICall {
  step: string;
  tier: Tier;
  system: string;
  prompt: string;
  /** JSON Schema the response must follow. */
  jsonSchema: Record<string, unknown>;
  timeoutMs?: number;
}

export interface AIResult {
  /** The parsed structured output, if the agent returned one. */
  output: unknown;
  raw: string;
  model?: string;
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
  durationMs: number;
}

export interface AdapterCapabilities {
  hooks: boolean;
  blockEdits: boolean;
  pathRules: boolean;
  subagents: boolean;
  nonInteractive: boolean;
  permissionPrompts: boolean;
}

export interface AgentAdapter {
  id: string;
  /** Is this agent used in this project (or installed on this machine)? */
  detect(projectRoot: string): Promise<boolean>;
  capabilities: AdapterCapabilities;
  writeAlwaysLoadedBlock(projectRoot: string, block: string): Promise<void>;
  removeAlwaysLoadedBlock(projectRoot: string): Promise<void>;
  installHooks(projectRoot: string, plan: HookPlan): Promise<void>;
  uninstallHooks(projectRoot: string, plan: HookPlan): Promise<void>;
  installPathRules(projectRoot: string, rules: PathRule[]): Promise<void>;
  installPermissions(projectRoot: string, rules: PermissionRule[]): Promise<void>;
  installUpdater(projectRoot: string, spec: UpdaterSpec): Promise<void>;
  runAI(call: AICall): Promise<AIResult>;
  uninstall(projectRoot: string): Promise<void>;
}
