import { findProjectRoot } from "../core/paths";
import { runStep, StepFailed } from "../ai/runner";
import { pingStep } from "../ai/schemas/ping";
import { aiStats, exportAiStats, renderAiStats } from "../core/stats/ai";
import { computeStats, renderStats } from "../core/stats/reads";
import { TIER_ORDER } from "../ai/tiers";
import type { Tier } from "../adapters/types";
import { CubeError } from "../core/ops";

/** `cube ai test`: runs the trivial step live, at one tier or all of them. */
export async function aiTest(opts: { tier?: string; forceFail?: boolean; cwd?: string }): Promise<string[]> {
  const root = findProjectRoot(opts.cwd);
  const tiers: Tier[] = opts.tier && opts.tier !== "all" ? [opts.tier as Tier] : TIER_ORDER;
  for (const t of tiers) if (!TIER_ORDER.includes(t)) throw new CubeError(`Unknown tier "${t}". Tiers: ${TIER_ORDER.join(", ")}`);
  const out: string[] = [];
  const input = { words: ["pear", "banana", "fig", "cherry"] };
  for (const tier of opts.forceFail ? ["haiku" as Tier] : tiers) {
    try {
      const r = await runStep(pingStep({ forceFailAt: opts.forceFail ? tier : undefined }), input, { root, tier, label: "ai test" });
      out.push(
        `${tier}: ok on ${r.tier} (${r.model ?? "model not reported"}) after ${r.attempts} attempt${r.attempts === 1 ? "" : "s"}, ${r.escalations} escalation${r.escalations === 1 ? "" : "s"} · ${r.tokensIn} tokens in, ${r.tokensOut} out`,
      );
    } catch (err) {
      if (err instanceof StepFailed) out.push(`${tier}: failed: ${err.message}`);
      else throw err;
    }
  }
  out.push("Each attempt is logged in context-cube/.logs/ai-calls.jsonl. See totals with: cube stats --ai");
  return out;
}

export function statsAi(opts: { ai?: boolean; export?: boolean; json?: boolean; all?: boolean; cwd?: string }): string {
  const root = findProjectRoot(opts.cwd);
  if (!opts.ai) {
    const report = computeStats(root);
    if (opts.json) return JSON.stringify(report, null, 2);
    return renderStats(report, { all: opts.all });
  }
  if (opts.export) return `Wrote ${exportAiStats(root)}. It has per-step numbers only: no file names or project text.`;
  if (opts.json) return JSON.stringify(aiStats(root), null, 2);
  return renderAiStats(aiStats(root));
}
