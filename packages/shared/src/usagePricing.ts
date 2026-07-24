/**
 * Versioned list-price catalog for estimating usage cost when a provider does
 * not meter (Codex reports tokens only). Estimates are computed at query time
 * from immutable token facts and are always labeled as estimates — they are
 * never persisted and never blended with provider-reported exact cost.
 *
 * Rates are USD per million tokens, effective-dated so a price change never
 * silently revalues history. `cacheWritePerMTok` covers cache-creation
 * tokens; providers without a cache-write concept omit it.
 */

export interface UsageModelPricing {
  readonly model: string;
  /** Inclusive ISO date this rate takes effect. */
  readonly effectiveFrom: string;
  readonly inputPerMTok: number;
  readonly cachedInputPerMTok: number;
  readonly cacheWritePerMTok?: number;
  readonly outputPerMTok: number;
}

export const USAGE_PRICING_VERSION = "2026-07-24";

const CATALOG: ReadonlyArray<UsageModelPricing> = [
  // OpenAI list prices (verified against ccusage output to the cent).
  {
    model: "gpt-5.6-sol",
    effectiveFrom: "2026-01-01",
    inputPerMTok: 10,
    cachedInputPerMTok: 1,
    outputPerMTok: 60,
  },
  {
    model: "gpt-5.5",
    effectiveFrom: "2025-11-01",
    inputPerMTok: 10,
    cachedInputPerMTok: 1,
    outputPerMTok: 60,
  },
];

export interface UsageTokenBreakdown {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
}

function rateFor(model: string, observedAtIso: string): UsageModelPricing | undefined {
  let best: UsageModelPricing | undefined;
  for (const entry of CATALOG) {
    if (entry.model !== model) continue;
    if (entry.effectiveFrom > observedAtIso.slice(0, 10)) continue;
    if (!best || entry.effectiveFrom > best.effectiveFrom) {
      best = entry;
    }
  }
  return best;
}

/** Integer micro-USD estimate, or undefined when the model has no rate (the
 * caller surfaces it as unpriced rather than $0). */
export function estimateCostMicroUsd(
  model: string,
  observedAtIso: string,
  tokens: UsageTokenBreakdown,
): number | undefined {
  const rate = rateFor(model, observedAtIso);
  if (!rate) {
    return undefined;
  }
  const usd =
    (tokens.inputTokens * rate.inputPerMTok +
      tokens.cachedInputTokens * rate.cachedInputPerMTok +
      tokens.cacheCreationTokens * (rate.cacheWritePerMTok ?? rate.inputPerMTok) +
      tokens.outputTokens * rate.outputPerMTok) /
    1_000_000;
  return Math.round(usd * 1_000_000);
}
