import { readTextOr } from "../fsutil";

export interface TranscriptUsage {
  /** API calls (unique assistant message ids). */
  apiCalls: number;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** Largest single-request context: input + cache creation + cache read. */
  peakContextTokens: number;
  models: string[];
}

/**
 * Reads token usage from a Claude Code session transcript (JSON lines).
 * One API response is written as several lines sharing a message id, so each
 * id is counted once.
 */
export function readTranscriptUsage(path: string): TranscriptUsage | undefined {
  const text = readTextOr(path, "");
  if (!text) return undefined;
  const seen = new Set<string>();
  const models = new Set<string>();
  const u: TranscriptUsage = {
    apiCalls: 0,
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    peakContextTokens: 0,
    models: [],
  };
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d?.type !== "assistant" || !d.message?.usage) continue;
    const id: string = d.message.id ?? d.requestId ?? line;
    if (seen.has(id)) continue;
    seen.add(id);
    const usage = d.message.usage;
    const input = Number(usage.input_tokens) || 0;
    const create = Number(usage.cache_creation_input_tokens) || 0;
    const read = Number(usage.cache_read_input_tokens) || 0;
    u.apiCalls++;
    u.inputTokens += input;
    u.cacheCreationTokens += create;
    u.cacheReadTokens += read;
    u.outputTokens += Number(usage.output_tokens) || 0;
    u.peakContextTokens = Math.max(u.peakContextTokens, input + create + read);
    if (d.message.model && d.message.model !== "<synthetic>") models.add(d.message.model);
  }
  u.models = [...models];
  return u.apiCalls ? u : undefined;
}

export interface AgentActivity {
  t: string;
  /** Text the agent wrote, or a tool call's input as JSON. */
  text: string;
  /** Set for tool calls. */
  tool?: string;
}

/**
 * The agent's own words and tool calls, with times, from a session transcript.
 * Tool results are left out: they echo files back, so they say nothing about
 * whether the agent used what it read. Undefined when the transcript is gone.
 */
export function readAgentActivity(path: string): AgentActivity[] | undefined {
  const text = readTextOr(path, "");
  if (!text) return undefined;
  const out: AgentActivity[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d?.type !== "assistant" || !Array.isArray(d.message?.content)) continue;
    const t = String(d.timestamp ?? "");
    for (const block of d.message.content) {
      if (block?.type === "text" && typeof block.text === "string") out.push({ t, text: block.text });
      else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking) out.push({ t, text: block.thinking });
      else if (block?.type === "tool_use") out.push({ t, text: JSON.stringify(block.input ?? {}), tool: String(block.name ?? "") });
    }
  }
  return out;
}
