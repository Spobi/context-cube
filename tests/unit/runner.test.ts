import { describe, expect, it } from "vitest";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { mapLimit, runStep, StepFailed, UsageLimitError, type Step } from "../../src/ai/runner";
import { FakeBackend, RecordingBackend, ReplayBackend } from "../../src/ai/backends";
import { tierFor } from "../../src/ai/tiers";
import { pingStep } from "../../src/ai/schemas/ping";
import { aiStats } from "../../src/core/stats/ai";
import { runClaude } from "../../src/adapters/claude-code/runner";
import { tempProject } from "../helpers";

const step: Step<{ n: number }, { double: number }> = {
  name: "ping",
  prompt: "Double the number.",
  schema: z.object({ double: z.number() }),
};

function logs(root: string) {
  return readFileSync(join(root, "context-cube/.logs/ai-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

describe("AI runner", () => {
  it("picks tiers by step and preset", () => {
    expect(tierFor("rows", "balanced")).toBe("opus");
    expect(tierFor("rows", "economy")).toBe("sonnet");
    expect(tierFor("history-summaries", "balanced")).toBe("haiku");
    expect(tierFor("history-summaries", "max")).toBe("sonnet");
    expect(tierFor("link-notes", "max")).toBe("haiku");
  });

  it("returns validated output and logs the call", async () => {
    const root = tempProject();
    const backend = new FakeBackend((call) => ({ double: JSON.parse(call.prompt.match(/```json\n([\s\S]*?)\n```/)![1]).n * 2 }));
    const r = await runStep(step, { n: 21 }, { root, backend, preset: "balanced" });
    expect(r.output).toEqual({ double: 42 });
    expect(r.tier).toBe("haiku");
    expect(r.attempts).toBe(1);
    expect(backend.calls[0].jsonSchema).toMatchObject({ type: "object", required: ["double"] });
    const [log] = logs(root);
    expect(log).toMatchObject({ step: "ping", preset: "balanced", tier: "haiku", attempt: 1, retry: false, schemaFailure: false });
  });

  it("retries once at the same tier, then escalates, and logs each attempt", async () => {
    const root = tempProject();
    const backend = new FakeBackend((call) => (call.tier === "haiku" ? { wrong: true } : { double: 2 }));
    const r = await runStep(step, { n: 1 }, { root, backend, preset: "balanced" });
    expect(r.tier).toBe("sonnet");
    expect(r.attempts).toBe(3);
    expect(r.escalations).toBe(1);
    expect(backend.calls.map((c) => c.tier)).toEqual(["haiku", "haiku", "sonnet"]);
    const l = logs(root);
    expect(l.map((x) => [x.tier, x.retry, x.escalatedFrom ?? null, x.schemaFailure])).toEqual([
      ["haiku", false, null, true],
      ["haiku", true, null, true],
      ["sonnet", false, "haiku", false],
    ]);
  });

  it("gives up after opus fails twice", async () => {
    const root = tempProject();
    const backend = new FakeBackend(() => ({ nope: 1 }));
    await expect(runStep(step, { n: 1 }, { root, backend, preset: "balanced" })).rejects.toBeInstanceOf(StepFailed);
    expect(backend.calls.map((c) => c.tier)).toEqual(["haiku", "haiku", "sonnet", "sonnet", "opus", "opus"]);
  });

  it("treats a thrown error like a failure and escalates", async () => {
    const root = tempProject();
    const backend = new FakeBackend((call) => (call.tier === "haiku" ? new Error("connection reset") : { double: 4 }));
    const r = await runStep(step, { n: 2 }, { root, backend });
    expect(r.tier).toBe("sonnet");
    expect(logs(root)[0].error).toBe("connection reset");
  });

  it("stops at once on a usage limit, without retrying or escalating", async () => {
    const root = tempProject();
    const backend = new FakeBackend(() => new Error("Claude AI usage limit reached · resets 3pm"));
    await expect(runStep(step, { n: 1 }, { root, backend })).rejects.toBeInstanceOf(UsageLimitError);
    expect(backend.calls).toHaveLength(1);
  });

  it("applies step checks beyond the schema (forced failure for the live test)", async () => {
    const root = tempProject();
    const backend = new FakeBackend(() => ({ longest: "banana", count: 4 }));
    const r = await runStep(pingStep({ forceFailAt: "haiku" }), { words: ["pear", "banana", "fig", "cherry"] }, { root, backend, tier: "haiku" });
    expect(r.tier).toBe("sonnet");
    expect(logs(root).filter((l) => l.schemaFailure)).toHaveLength(2);
  });

  it("records live answers and replays them without any AI calls", async () => {
    const root = tempProject();
    const dir = join(root, "recorded");
    const live = new FakeBackend(() => ({ double: 10 }));
    await runStep(step, { n: 5 }, { root, backend: new RecordingBackend(live, dir) });
    const replay = await runStep(step, { n: 5 }, { root, backend: new ReplayBackend(dir) });
    expect(replay.output).toEqual({ double: 10 });
    await expect(runStep(step, { n: 6 }, { root, backend: new ReplayBackend(dir) })).rejects.toThrow(/No recorded response/);
  });

  it("summarizes calls per step for cube stats --ai", async () => {
    const root = tempProject();
    await runStep(step, { n: 1 }, { root, backend: new FakeBackend((c) => (c.tier === "haiku" ? {} : { double: 2 })) });
    const [s] = aiStats(root);
    expect(s).toMatchObject({ step: "ping", calls: 3, succeeded: 1, retries: 1, escalations: 1, schemaFailures: 2, byTier: { haiku: 2, sonnet: 1 } });
  });

  it("runs work in parallel up to the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, async (x) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(peak).toBe(4);
  });
});

describe("Claude Code non-interactive runner", () => {
  it("passes the tier, schema, and prompt, and reads structured output and usage", async () => {
    const dir = tempProject({}, { git: false });
    const fake = join(dir, "claude");
    writeFileSync(
      fake,
      `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/args.txt"
cat > "${dir}/stdin.txt"
echo '{"type":"result","subtype":"success","is_error":false,"result":"{\\"double\\":8}","structured_output":{"double":8},"total_cost_usd":0.001,"usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":7},"modelUsage":{"claude-haiku-4-5-20251001":{"outputTokens":7,"canonicalModel":"claude-haiku-4-5"}}}'
`,
    );
    chmodSync(fake, 0o755);
    process.env.CUBE_CLAUDE_BIN = fake;
    try {
      const r = await runClaude({ step: "ping", tier: "haiku", system: "SYSTEM", prompt: "PROMPT TEXT", jsonSchema: { type: "object" } });
      expect(r.output).toEqual({ double: 8 });
      expect(r.tokensIn).toBe(115);
      expect(r.tokensOut).toBe(7);
      expect(r.model).toBe("claude-haiku-4-5");
      const args = readFileSync(join(dir, "args.txt"), "utf8").split("\n");
      expect(args.slice(0, 3)).toEqual(["-p", "--model", "haiku"]);
      expect(args).toContain("--json-schema");
      expect(args).toContain("SYSTEM");
      expect(readFileSync(join(dir, "stdin.txt"), "utf8")).toBe("PROMPT TEXT");
    } finally {
      delete process.env.CUBE_CLAUDE_BIN;
    }
  });
});
