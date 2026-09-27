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

/** A tool call as the cube's hooks see it, whatever the agent calls its tools. */
export type ToolCall =
  /** Files an edit tool changes (as the agent named them: absolute, or relative to the session's cwd). */
  | { kind: "edit"; files: string[] }
  | { kind: "shell"; command: string }
  | { kind: "other" };

/** What the cube's hooks need to know about an agent's hook input and wording. */
export interface HookDialect {
  toolCall(input: { tool_name?: string; tool_input?: Record<string, unknown> }): ToolCall;
  /** How the main session hands the update plan to the updater helper. */
  updateHelper: string;
  /** Tells the agent how the person can run a command it may not run itself. */
  personRuns(cmd: string): string;
  /**
   * Person-only commands: "ask" answers the hook with a permission prompt
   * (Claude Code); "rules" lets the agent's own command rules ask (Codex, whose
   * hooks can't ask), for a command shaped exactly like those rules.
   */
  personPrompt: "ask" | "rules";
  /** With "rules": will the agent's command rules ask the person before running this command? */
  rulesWillAsk?(root: string, cmd: string): boolean;
}

export interface AgentAdapter {
  id: string;
  /** The agent's name for people ("Claude Code", "Codex"). */
  name: string;
  hookDialect?: HookDialect;
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
