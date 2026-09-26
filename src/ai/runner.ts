import { z } from "zod";
import type { AICall, Tier } from "../adapters/types";
import { appendLine } from "../core/fsutil";
import { loadConfig } from "../core/config";
import { logFiles } from "../core/logs/store";
import { aiAdapter } from "../adapters/registry";
import { adapterBackend, RecordingBackend, ReplayBackend, ReplayOrRecordBackend, type AIBackend } from "./backends";
import { nextTier, tierFor, type Preset } from "./tiers";

/**
 * The AI runner (plan 4.2). Every AI call goes through here: it picks the
 * tier for the step and preset, validates the answer against the step's
 * schema, retries once at the same tier, then escalates a tier (plan 5.3),
 * and logs every attempt (plan 5.4).
 */

export interface Step<I, O> {
  name: string;
  /** The step's instructions (a markdown prompt file). */
  prompt: string;
  schema: z.ZodType<O>;
  /** Renders the input for the model. Defaults to pretty JSON. */
  render?: (input: I) => string;
  /** Extra checks beyond the schema. Return an error message to reject. */
  validate?: (output: O, input: I, tier: Tier) => string | undefined;
}

export interface RunContext {
  root: string;
  preset?: Preset;
  backend?: AIBackend;
  /** Start at this tier instead of the step's default (e.g. "unclear → sonnet"). */
  tier?: Tier;
  /** Label for logs, e.g. which file or box this call was about. */
  label?: string;
}

export interface StepResult<O> {
  output: O;
  tier: Tier;
  model?: string;
  attempts: number;
  escalations: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export class StepFailed extends Error {
  constructor(message: string, public attempts: number) {
    super(message);
  }
}

/**
 * The agent's plan hit a usage or rate limit. Retrying or escalating would
 * only waste usage, so the step stops; builds save their place and resume.
 */
export class UsageLimitError extends Error {}

export const LIMIT_RE = /usage limit|limit reached|rate[ _-]?limit|too many requests|\b429\b|overloaded|resets? (at|in)\b/i;

export interface AICallLog {
  t: string;
  step: string;
  preset: Preset;
  tier: Tier;
  model?: string;
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
  durationMs: number;
  attempt: number;
  retry: boolean;
  escalatedFrom?: Tier;
  schemaFailure: boolean;
  error?: string;
  label?: string;
}

/** The backend for this environment: replay or recording when asked, else the agent. */
export function defaultBackend(root: string): AIBackend {
  if (process.env.CUBE_AI_REPLAY && process.env.CUBE_AI_RECORD && process.env.CUBE_AI_REPLAY === process.env.CUBE_AI_RECORD) {
    let agents: string[] = [];
    try {
      agents = loadConfig(root).agents;
    } catch {
      // default adapter
    }
    return new ReplayOrRecordBackend(adapterBackend(aiAdapter(agents)), process.env.CUBE_AI_RECORD);
  }
  if (process.env.CUBE_AI_REPLAY) return new ReplayBackend(process.env.CUBE_AI_REPLAY);
  let agents: string[] = [];
  try {
    agents = loadConfig(root).agents;
  } catch {
    // default adapter
  }
  const live = adapterBackend(aiAdapter(agents));
  if (process.env.CUBE_AI_RECORD) return new RecordingBackend(live, process.env.CUBE_AI_RECORD);
  return live;
}

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

function renderInput<I, O>(step: Step<I, O>, input: I): string {
  const body = step.render ? step.render(input) : `\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``;
  return `${body}\n\nAnswer with JSON that matches the required schema. Output nothing else.`;
}

export async function runStep<I, O>(step: Step<I, O>, input: I, ctx: RunContext): Promise<StepResult<O>> {
  let preset: Preset = ctx.preset ?? "balanced";
  if (!ctx.preset) {
    try {
      preset = loadConfig(ctx.root).preset;
    } catch {
      // keep balanced
    }
  }
  const backend = ctx.backend ?? defaultBackend(ctx.root);
  const jsonSchema = jsonSchemaOf(step.schema);
  const basePrompt = renderInput(step, input);
  let prompt = basePrompt;
  let tier: Tier = ctx.tier ?? tierFor(step.name, preset);
  let attempt = 0;
  let escalations = 0;
  let triesAtTier = 0;
  let escalatedFrom: Tier | undefined;
  const totals = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  let lastError = "";
  for (;;) {
    attempt++;
    triesAtTier++;
    const call: AICall = { step: step.name, tier, system: step.prompt, prompt, jsonSchema };
    const log: AICallLog = {
      t: new Date().toISOString(),
      step: step.name,
      preset,
      tier,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
      attempt,
      retry: triesAtTier > 1,
      escalatedFrom: triesAtTier === 1 ? escalatedFrom : undefined,
      schemaFailure: false,
      label: ctx.label,
    };
    let problem: string | undefined;
    let output: O | undefined;
    try {
      const r = await backend.run(call);
      Object.assign(log, { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd, durationMs: r.durationMs });
      totals.tokensIn += r.tokensIn;
      totals.tokensOut += r.tokensOut;
      totals.costUsd += r.costUsd ?? 0;
      const parsed = step.schema.safeParse(r.output);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        problem = `schema: ${issue.path.join(".") || "output"}: ${issue.message}`;
        log.schemaFailure = true;
      } else {
        const extra = step.validate?.(parsed.data, input, tier);
        if (extra) {
          problem = `check: ${extra}`;
          log.schemaFailure = true;
        } else {
          output = parsed.data;
        }
      }
      if (problem) log.error = problem;
      writeLog(ctx.root, log);
      if (output !== undefined) {
        return { output, tier, model: r.model, attempts: attempt, escalations, ...totals };
      }
    } catch (err) {
      problem = (err as Error).message;
      log.error = problem.slice(0, 500);
      writeLog(ctx.root, log);
      if (err instanceof UsageLimitError || LIMIT_RE.test(problem)) {
        throw err instanceof UsageLimitError ? err : new UsageLimitError(problem);
      }
    }
    lastError = problem ?? "unknown";
    // Tell the next attempt why the last answer was rejected.
    prompt = `${basePrompt}\n\nA previous answer was rejected: ${lastError.slice(0, 1500)}\nFix that and answer again.`;
    if (triesAtTier < 2) continue; // retry once at the same tier
    const up = nextTier(tier);
    if (!up) throw new StepFailed(`AI step "${step.name}" failed after ${attempt} attempts: ${lastError}`, attempt);
    escalatedFrom = tier;
    tier = up;
    triesAtTier = 0;
    escalations++;
  }
}

function writeLog(root: string, log: AICallLog): void {
  try {
    appendLine(logFiles(root).aiCalls, JSON.stringify(log));
  } catch {
    // Logging must not stop a build.
  }
}

/** Runs `fn` over items with at most `limit` in flight (plan 4.2: default 4). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      // After one failure (say, a usage limit), start nothing new.
      if (failed) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  });
  await Promise.all(workers);
  return out;
}
