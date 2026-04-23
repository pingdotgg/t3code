import { normalizeModelSlug } from "./model.ts";
import type { ProviderKind } from "@t3tools/contracts";

export type { ProviderKind };

/**
 * USD price per 1,000,000 tokens for each token class.
 *
 * - `inputPerMTok` — non-cached prompt tokens.
 * - `cachedInputPerMTok` — cache-READ tokens (Anthropic 0.1× / OpenAI cached input).
 * - `cacheCreationInputPerMTok` — cache-WRITE premium tier (Anthropic 1.25×).
 *   Providers without a distinct cache-write tier (OpenAI, etc.) set this equal
 *   to `inputPerMTok`.
 * - `outputPerMTok` — model output tokens.
 * - `reasoningOutputPerMTok` — reasoning output. Defaults to `outputPerMTok`
 *   when a model does not bill reasoning tokens separately.
 */
export interface ModelPricing {
  readonly provider: ProviderKind | "unknown";
  readonly inputPerMTok: number;
  readonly cachedInputPerMTok: number;
  readonly cacheCreationInputPerMTok: number;
  readonly outputPerMTok: number;
  readonly reasoningOutputPerMTok: number;
}

/**
 * Raw seed rates. We derive the cache-creation + reasoning tiers when not
 * specified so the table below stays readable.
 */
type SeedPricing = {
  readonly provider: ProviderKind | "unknown";
  readonly inputPerMTok: number;
  readonly cachedInputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheCreationInputPerMTok?: number;
  readonly reasoningOutputPerMTok?: number;
};

const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25;

/** Raw seed rates (USD per 1M tokens). Source: public provider pricing pages. */
const SEED_PRICING: ReadonlyArray<readonly [string, SeedPricing]> = [
  // ── Anthropic / Claude ───────────────────────────────────────────────
  // Cache-read = 0.1× input; cache-write = 1.25× input.
  // Extended-thinking tokens bill as output.
  [
    "claude-sonnet-4-6",
    {
      provider: "claudeAgent",
      inputPerMTok: 3,
      cachedInputPerMTok: 0.3,
      outputPerMTok: 15,
    },
  ],
  [
    "claude-opus-4-7",
    {
      provider: "claudeAgent",
      inputPerMTok: 15,
      cachedInputPerMTok: 1.5,
      outputPerMTok: 75,
    },
  ],
  [
    "claude-opus-4-6",
    {
      provider: "claudeAgent",
      inputPerMTok: 15,
      cachedInputPerMTok: 1.5,
      outputPerMTok: 75,
    },
  ],
  [
    "claude-opus-4-5",
    {
      provider: "claudeAgent",
      inputPerMTok: 15,
      cachedInputPerMTok: 1.5,
      outputPerMTok: 75,
    },
  ],
  [
    "claude-haiku-4-5",
    {
      provider: "claudeAgent",
      inputPerMTok: 1,
      cachedInputPerMTok: 0.1,
      outputPerMTok: 5,
    },
  ],
  // ── OpenAI / Codex ───────────────────────────────────────────────────
  // OpenAI does not bill a separate cache-creation tier — cached-input rate
  // applies on hits; misses price at the normal input rate. We therefore
  // default cacheCreationInputPerMTok to inputPerMTok below.
  [
    "gpt-5.4",
    {
      provider: "codex",
      inputPerMTok: 1.25,
      cachedInputPerMTok: 0.125,
      outputPerMTok: 10,
    },
  ],
  [
    "gpt-5.3-codex",
    {
      provider: "codex",
      inputPerMTok: 1.25,
      cachedInputPerMTok: 0.125,
      outputPerMTok: 10,
    },
  ],
  [
    "gpt-5.3-codex-spark",
    {
      provider: "codex",
      inputPerMTok: 0.25,
      cachedInputPerMTok: 0.025,
      outputPerMTok: 2,
    },
  ],
  [
    "gpt-5.4-mini",
    {
      provider: "codex",
      inputPerMTok: 0.25,
      cachedInputPerMTok: 0.025,
      outputPerMTok: 2,
    },
  ],
];

/**
 * Pricing table keyed by canonical model slug.
 * Frozen so consumers can't mutate rates at runtime.
 */
export const PRICING_TABLE: ReadonlyMap<string, ModelPricing> = (() => {
  const map = new Map<string, ModelPricing>();
  for (const [slug, raw] of SEED_PRICING) {
    const cacheCreationInputPerMTok =
      raw.cacheCreationInputPerMTok ??
      (raw.provider === "claudeAgent"
        ? raw.inputPerMTok * ANTHROPIC_CACHE_WRITE_MULTIPLIER
        : raw.inputPerMTok);
    map.set(slug, {
      ...raw,
      cacheCreationInputPerMTok,
      reasoningOutputPerMTok: raw.reasoningOutputPerMTok ?? raw.outputPerMTok,
    });
  }
  return map;
})();

/** Zero-cost fallback for unknown models. Keeps total cost honest (no fake rate). */
export const UNKNOWN_MODEL_PRICING: ModelPricing = {
  provider: "unknown",
  inputPerMTok: 0,
  cachedInputPerMTok: 0,
  cacheCreationInputPerMTok: 0,
  outputPerMTok: 0,
  reasoningOutputPerMTok: 0,
};

/**
 * Resolve pricing for a model slug. Tries provider-aware alias normalization
 * first (so `"sonnet"` → `"claude-sonnet-4-6"`), then direct lookup, then
 * returns the zero-rate fallback.
 */
export function getPricing(
  model: string | null | undefined,
  provider?: ProviderKind,
): ModelPricing {
  if (typeof model !== "string") {
    return UNKNOWN_MODEL_PRICING;
  }
  const trimmed = model.trim();
  if (!trimmed) {
    return UNKNOWN_MODEL_PRICING;
  }
  // Provider-aware alias normalization.
  if (provider) {
    const normalized = normalizeModelSlug(trimmed, provider);
    if (normalized) {
      const direct = PRICING_TABLE.get(normalized);
      if (direct) return direct;
    }
  }
  // Direct lookup (raw slug may already be canonical).
  const direct = PRICING_TABLE.get(trimmed);
  if (direct) return direct;

  // Try each provider's aliases as a last resort.
  const providers: ProviderKind[] = ["codex", "claudeAgent", "cursor", "opencode"];
  for (const p of providers) {
    const normalized = normalizeModelSlug(trimmed, p);
    if (normalized) {
      const hit = PRICING_TABLE.get(normalized);
      if (hit) return hit;
    }
  }
  return UNKNOWN_MODEL_PRICING;
}

export interface TurnTokenDeltas {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

export interface TurnCostBreakdown {
  readonly inputUsd: number;
  readonly cachedUsd: number;
  readonly cacheCreationUsd: number;
  readonly outputUsd: number;
  readonly reasoningUsd: number;
  readonly totalUsd: number;
}

export const ZERO_COST: TurnCostBreakdown = {
  inputUsd: 0,
  cachedUsd: 0,
  cacheCreationUsd: 0,
  outputUsd: 0,
  reasoningUsd: 0,
  totalUsd: 0,
};

function finite(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Compute USD cost for one turn's token deltas.
 *
 * Token classes:
 *   - `inputTokens` — non-cached input.
 *   - `cachedInputTokens` — cache-READ tokens (discounted).
 *   - `cacheCreationInputTokens` — cache-WRITE tokens (premium on Anthropic).
 *   - `outputTokens` — model output.
 *   - `reasoningOutputTokens` — reasoning output. Defaults to output rate.
 *
 * Each class is billed *additively*, matching how providers invoice.
 */
export function computeTurnCost(
  model: string | null | undefined,
  deltas: Partial<TurnTokenDeltas>,
  provider?: ProviderKind,
): TurnCostBreakdown {
  const pricing = getPricing(model, provider);
  const input = finite(deltas.inputTokens);
  const cached = finite(deltas.cachedInputTokens);
  const cacheCreation = finite(deltas.cacheCreationInputTokens);
  const output = finite(deltas.outputTokens);
  const reasoning = finite(deltas.reasoningOutputTokens);

  const inputUsd = (input / 1_000_000) * pricing.inputPerMTok;
  const cachedUsd = (cached / 1_000_000) * pricing.cachedInputPerMTok;
  const cacheCreationUsd = (cacheCreation / 1_000_000) * pricing.cacheCreationInputPerMTok;
  const outputUsd = (output / 1_000_000) * pricing.outputPerMTok;
  const reasoningUsd = (reasoning / 1_000_000) * pricing.reasoningOutputPerMTok;
  const totalUsd = inputUsd + cachedUsd + cacheCreationUsd + outputUsd + reasoningUsd;

  return { inputUsd, cachedUsd, cacheCreationUsd, outputUsd, reasoningUsd, totalUsd };
}

/** Format USD amount for UI display. */
export function formatUsd(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "$0.00";
  }
  if (value < 0.01) {
    return `<$0.01`;
  }
  if (value < 1) {
    return `$${value.toFixed(3).replace(/0$/, "")}`;
  }
  if (value < 100) {
    return `$${value.toFixed(2)}`;
  }
  return `$${Math.round(value).toLocaleString("en-US")}`;
}
