import { createHash } from "node:crypto";
import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { exists, readJson, writeJson } from "../core/fsutil";
import type { AICall, AIResult, AgentAdapter } from "../adapters/types";

/** Anything that can answer an AI call: a real agent, or a test double. */
export interface AIBackend {
  run(call: AICall): Promise<AIResult>;
}

export function adapterBackend(adapter: AgentAdapter): AIBackend {
  return { run: (call) => adapter.runAI(call) };
}

export function callKey(call: AICall): string {
  return createHash("sha256").update(`${call.step}\n${call.system}\n${call.prompt}`).digest("hex").slice(0, 20);
}

/**
 * Replays recorded responses (plan 4.2: tests run without live AI calls).
 * Files live at <dir>/<step>/<key>.json, keyed by the prompt, not the tier,
 * so escalation replays the same answer.
 */
export class ReplayBackend implements AIBackend {
  constructor(private dir: string) {}
  async run(call: AICall): Promise<AIResult> {
    const path = join(this.dir, call.step, `${callKey(call)}.json`);
    if (!exists(path)) throw new Error(`No recorded response for step "${call.step}" (${path}). Record one with CUBE_AI_RECORD=${this.dir}.`);
    const rec = readJson<{ output: unknown }>(path);
    // For pruning recordings no test uses any more (see CONTRIBUTING.md).
    if (process.env.CUBE_AI_TRACK) appendFileSync(process.env.CUBE_AI_TRACK, `${call.step}/${callKey(call)}.json\n`);
    return { output: rec.output, raw: JSON.stringify(rec.output), model: `recorded-${call.tier}`, tokensIn: 0, tokensOut: 0, durationMs: 0 };
  }
}

/** Wraps a live backend and saves each response for later replay. */
export class RecordingBackend implements AIBackend {
  constructor(private inner: AIBackend, private dir: string) {}
  async run(call: AICall): Promise<AIResult> {
    const r = await this.inner.run(call);
    writeJson(join(this.dir, call.step, `${callKey(call)}.json`), { step: call.step, tier: call.tier, output: r.output });
    return r;
  }
}

/** A scripted backend for unit tests: answers from a function. */
export class FakeBackend implements AIBackend {
  calls: AICall[] = [];
  constructor(private answer: (call: AICall, n: number) => unknown) {}
  async run(call: AICall): Promise<AIResult> {
    this.calls.push(call);
    const output = await this.answer(call, this.calls.length);
    if (output instanceof Error) throw output;
    const raw = JSON.stringify(output);
    return { output, raw, model: `fake-${call.tier}`, tokensIn: Math.ceil((call.system.length + call.prompt.length) / 4), tokensOut: Math.ceil(raw.length / 4), durationMs: 1 };
  }
}

/** Replays what was recorded, and records live answers for anything missing. */
export class ReplayOrRecordBackend implements AIBackend {
  private replay: ReplayBackend;
  private record: RecordingBackend;
  constructor(live: AIBackend, dir: string) {
    this.replay = new ReplayBackend(dir);
    this.record = new RecordingBackend(live, dir);
  }
  async run(call: AICall): Promise<AIResult> {
    try {
      return await this.replay.run(call);
    } catch {
      return this.record.run(call);
    }
  }
}
