import { z } from "zod";
import type { Step } from "../runner";
import prompt from "../prompts/ping.md";

export const PingInput = z.object({ words: z.array(z.string()) });
export const PingOutput = z.object({ longest: z.string(), count: z.number().int() });

export type PingIn = z.infer<typeof PingInput>;
export type PingOut = z.infer<typeof PingOutput>;

/** The trivial step used to test the runner live at each tier. */
export function pingStep(opts: { forceFailAt?: string } = {}): Step<PingIn, PingOut> {
  return {
    name: "ping",
    prompt,
    schema: PingOutput,
    validate: (out, input, tier) => {
      if (opts.forceFailAt && tier === opts.forceFailAt) return `forced failure at ${tier} (testing escalation)`;
      const expected = [...input.words].sort((a, b) => b.length - a.length || input.words.indexOf(a) - input.words.indexOf(b))[0];
      if (out.longest !== expected) return `expected "${expected}", got "${out.longest}"`;
      if (out.count !== input.words.length) return `expected count ${input.words.length}, got ${out.count}`;
      return undefined;
    },
  };
}
