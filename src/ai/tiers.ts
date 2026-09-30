import type { Tier } from "../adapters/types";
import type { CubeConfig } from "../core/config";

/**
 * Which tier each step uses, per preset (plan 5.2). Models are named by tier,
 * never by version, so the tool keeps working as new models ship.
 */
export type Preset = CubeConfig["preset"];

export const STEP_TIERS: Record<string, Record<Preset, Tier>> = {
  /** Classify candidate source files. Unclear files go up a tier (see classify step). */
  classify: { economy: "haiku", balanced: "haiku", max: "sonnet" },
  recipe: { economy: "sonnet", balanced: "sonnet", max: "opus" },
  rows: { economy: "sonnet", balanced: "opus", max: "opus" },
  "history-summaries": { economy: "haiku", balanced: "haiku", max: "sonnet" },
  "invariant-labels": { economy: "haiku", balanced: "sonnet", max: "sonnet" },
  "box-overviews": { economy: "haiku", balanced: "sonnet", max: "sonnet" },
  "link-notes": { economy: "haiku", balanced: "haiku", max: "haiku" },
  "candidate-invariants": { economy: "sonnet", balanced: "sonnet", max: "opus" },
  "interview-rules": { economy: "sonnet", balanced: "sonnet", max: "sonnet" },
  detail: { economy: "sonnet", balanced: "sonnet", max: "opus" },
  update: { economy: "haiku", balanced: "haiku", max: "sonnet" },
  /** Blind scoring of bench runs: the biggest model, whatever the preset. */
  "bench-judge": { economy: "opus", balanced: "opus", max: "opus" },
  /** A trivial step for testing the runner live. */
  ping: { economy: "haiku", balanced: "haiku", max: "haiku" },
};

export const TIER_ORDER: Tier[] = ["haiku", "sonnet", "opus"];

/** How a tier is named to a person, smallest first. */
export const TIER_NAME: Record<Tier, string> = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };
export const TIER_SIZE: Record<Tier, string> = { haiku: "smallest", sonnet: "mid-size", opus: "largest" };

export function tierFor(step: string, preset: Preset): Tier {
  const row = STEP_TIERS[step];
  if (!row) throw new Error(`Unknown AI step "${step}".`);
  return row[preset];
}

export function nextTier(t: Tier): Tier | undefined {
  const i = TIER_ORDER.indexOf(t);
  return TIER_ORDER[i + 1];
}

export function tierAbove(t: Tier, by = 1): Tier {
  const i = Math.min(TIER_ORDER.length - 1, TIER_ORDER.indexOf(t) + by);
  return TIER_ORDER[i];
}
