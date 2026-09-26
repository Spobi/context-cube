import { join } from "node:path";
import { appendLine, readJsonl, writeJson } from "../fsutil";
import { logFiles } from "../logs/store";
import { cubePaths } from "../paths";
import { fmtInt } from "../tokens";
import type { AICallLog } from "../../ai/runner";
import { version } from "../tool";

/**
 * Quality signals per AI step (plan 5.4): cost alone can't show whether a
 * cheaper tier was good enough.
 */
export interface QualitySignal {
  t: string;
  kind: "spot-check-fail" | "spot-check-ok" | "proposal-rejected" | "proposal-approved" | "edited-by-person";
  step: string;
  tier?: string;
  id?: string;
}

export function qualityPath(root: string): string {
  return join(logFiles(root).dir, "quality.jsonl");
}

export function recordQuality(root: string, s: Omit<QualitySignal, "t">): void {
  try {
    appendLine(qualityPath(root), JSON.stringify({ t: new Date().toISOString(), ...s }));
  } catch {
    // never block on stats
  }
}

export interface StepStats {
  step: string;
  calls: number;
  succeeded: number;
  byTier: Record<string, number>;
  models: string[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  retries: number;
  escalations: number;
  schemaFailures: number;
  errors: number;
  durationMs: number;
  quality: Record<QualitySignal["kind"], number>;
}

export function aiStats(root: string): StepStats[] {
  const calls = readJsonl<AICallLog>(logFiles(root).aiCalls);
  const quality = readJsonl<QualitySignal>(qualityPath(root));
  const by = new Map<string, StepStats>();
  const get = (step: string) => {
    let s = by.get(step);
    if (!s) {
      s = {
        step,
        calls: 0,
        succeeded: 0,
        byTier: {},
        models: [],
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        retries: 0,
        escalations: 0,
        schemaFailures: 0,
        errors: 0,
        durationMs: 0,
        quality: { "spot-check-fail": 0, "spot-check-ok": 0, "proposal-rejected": 0, "proposal-approved": 0, "edited-by-person": 0 },
      };
      by.set(step, s);
    }
    return s;
  };
  for (const c of calls) {
    const s = get(c.step);
    s.calls++;
    if (!c.error) s.succeeded++;
    s.byTier[c.tier] = (s.byTier[c.tier] ?? 0) + 1;
    if (c.model && !s.models.includes(c.model)) s.models.push(c.model);
    s.tokensIn += c.tokensIn || 0;
    s.tokensOut += c.tokensOut || 0;
    s.costUsd += c.costUsd || 0;
    if (c.retry) s.retries++;
    if (c.escalatedFrom) s.escalations++;
    if (c.schemaFailure) s.schemaFailures++;
    else if (c.error) s.errors++;
    s.durationMs += c.durationMs || 0;
  }
  for (const q of quality) get(q.step).quality[q.kind]++;
  return [...by.values()].sort((a, b) => a.step.localeCompare(b.step));
}

export function renderAiStats(stats: StepStats[]): string {
  if (!stats.length) return "No AI calls logged yet.";
  const out = ["AI use by step (tokens as reported by the agent; cost is the agent's list-price figure, not what a subscription pays)", ""];
  let tin = 0;
  let tout = 0;
  let cost = 0;
  for (const s of stats) {
    tin += s.tokensIn;
    tout += s.tokensOut;
    cost += s.costUsd;
    const tiers = Object.entries(s.byTier).map(([t, n]) => `${t} ${n}`).join(", ");
    out.push(`${s.step}`);
    out.push(`  calls ${s.calls} (${s.succeeded} ok) · tiers: ${tiers} · models: ${s.models.join(", ") || "?"}`);
    out.push(`  tokens in ${fmtInt(s.tokensIn)}, out ${fmtInt(s.tokensOut)} · ~$${s.costUsd.toFixed(2)} · ${Math.round(s.durationMs / 1000)}s`);
    out.push(`  retries ${s.retries} · escalations ${s.escalations} · schema failures ${s.schemaFailures} · other errors ${s.errors}`);
    const q = s.quality;
    const qs = [
      q["spot-check-ok"] + q["spot-check-fail"] ? `spot checks ${q["spot-check-fail"]} failed of ${q["spot-check-ok"] + q["spot-check-fail"]}` : "",
      q["proposal-approved"] + q["proposal-rejected"] ? `proposals ${q["proposal-rejected"]} rejected of ${q["proposal-approved"] + q["proposal-rejected"]}` : "",
      q["edited-by-person"] ? `AI text later edited by a person: ${q["edited-by-person"]}` : "",
    ].filter(Boolean);
    if (qs.length) out.push(`  quality: ${qs.join(" · ")}`);
  }
  out.push("", `Total: ${fmtInt(tin)} tokens in, ${fmtInt(tout)} out, ~$${cost.toFixed(2)} list price.`);
  return out.join("\n");
}

/** A shareable file with per-step numbers only: no file names, text, or labels. */
export function exportAiStats(root: string): string {
  const stats = aiStats(root);
  const path = join(cubePaths(root).logs, "ai-usage-export.json");
  writeJson(path, {
    tool: "context-cube",
    version: version(),
    exported: new Date().toISOString().slice(0, 10),
    steps: stats.map((s) => ({
      step: s.step,
      calls: s.calls,
      succeeded: s.succeeded,
      byTier: s.byTier,
      models: s.models,
      tokensIn: s.tokensIn,
      tokensOut: s.tokensOut,
      retries: s.retries,
      escalations: s.escalations,
      schemaFailures: s.schemaFailures,
      quality: s.quality,
    })),
  });
  return path;
}
