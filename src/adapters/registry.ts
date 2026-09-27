import type { AgentAdapter } from "./types";
import { claudeCodeAdapter } from "./claude-code/index";
import { genericAdapter } from "./generic/index";
import { codexAdapter } from "./codex/index";

export const ADAPTERS: AgentAdapter[] = [claudeCodeAdapter, codexAdapter, genericAdapter];

export function getAdapter(id: string): AgentAdapter {
  const a = ADAPTERS.find((x) => x.id === id);
  if (!a) throw new Error(`Unknown agent "${id}". Known agents: ${ADAPTERS.map((x) => x.id).join(", ")}`);
  return a;
}

/** Adapters configured for a project; claude-code if nothing is configured. */
export function adaptersFor(agents: string[]): AgentAdapter[] {
  const ids = agents.length ? agents : ["claude-code"];
  return ids.map(getAdapter);
}

/** The adapter used for AI steps: the first configured one that can run non-interactively. */
export function aiAdapter(agents: string[]): AgentAdapter {
  const a = adaptersFor(agents).find((x) => x.capabilities.nonInteractive);
  return a ?? claudeCodeAdapter;
}

/** The hook dialect for an agent id; Claude Code's when unknown (hooks written before --agent existed). */
export function dialectFor(id: string | undefined) {
  return (ADAPTERS.find((x) => x.id === id) ?? claudeCodeAdapter).hookDialect!;
}
