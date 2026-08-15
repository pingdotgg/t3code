/**
 * Model rate lookup and cost arithmetic.
 *
 * Rates come from LiteLLM's `model_prices_and_context_window.json`, the same
 * table `ccusage` prices against, plus a small Cursor/OpenUsage supplement for
 * models public catalogs omit (`auto`, Composer, …) and slug aliases for
 * Cursor's usage-export names.
 *
 * @module usagePricing
 */
import type { UsageCostSource, UsageTokenTotals } from "@t3tools/contracts";

/**
 * The subset of a LiteLLM entry we price against. All values are USD per token.
 *
 * LiteLLM also publishes tiered variants (`*_above_272k_tokens`, `*_flex`,
 * `*_priority`, `*_batches`). We deliberately price at the base tier: the
 * transcripts don't record which tier served a request, so anything else would
 * be a guess dressed up as precision.
 */
export interface ModelRate {
  readonly inputCostPerToken: number;
  readonly outputCostPerToken: number;
  readonly cacheReadCostPerToken: number;
  readonly cacheCreationCostPerToken: number;
}

export type RateTable = ReadonlyMap<string, ModelRate>;

/** Raw shape of one LiteLLM entry, narrowed to the fields we read. */
interface LiteLlmEntry {
  readonly input_cost_per_token?: unknown;
  readonly output_cost_per_token?: unknown;
  readonly cache_read_input_token_cost?: unknown;
  readonly cache_creation_input_token_cost?: unknown;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Converts OpenUsage / Cursor "$ per million tokens" figures into per-token. */
function perMillion(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number = input,
): ModelRate {
  const scale = 1_000_000;
  return {
    inputCostPerToken: input / scale,
    outputCostPerToken: output / scale,
    cacheReadCostPerToken: cacheRead / scale,
    cacheCreationCostPerToken: cacheWrite / scale,
  };
}

/**
 * Cursor-native and catalog-missing rates (USD / MTok), from OpenUsage's
 * pricing supplement / https://cursor.com/docs/models-and-pricing.md.
 *
 * Checked before LiteLLM so a $0 stub (e.g. OpenRouter's `auto`) cannot win.
 */
const SUPPLEMENT_RATES: ReadonlyMap<string, ModelRate> = new Map([
  ["auto", perMillion(1.25, 6.0, 0.25, 1.25)],
  ["composer-1", perMillion(1.25, 10.0, 0.125, 1.25)],
  ["composer-1.5", perMillion(3.5, 17.5, 0.35, 3.5)],
  ["composer-2", perMillion(0.5, 2.5, 0.2, 0.5)],
  ["composer-2-fast", perMillion(1.5, 7.5, 0.35, 1.5)],
  ["composer-2.5", perMillion(0.5, 2.5, 0.2, 0.5)],
  ["composer-2.5-fast", perMillion(3.0, 15.0, 0.5, 3.0)],
  ["grok-4.5", perMillion(2.0, 6.0, 0.5, 2.0)],
  ["grok-4.5-fast", perMillion(4.0, 18.0, 1.0, 4.0)],
  ["grok-build-0.1", perMillion(0.2, 1.5, 0.05, 0.2)],
  ["kimi-k2.7-code", perMillion(0.95, 4.0, 0.19, 0.95)],
  ["claude-opus-4-7-fast", perMillion(30.0, 150.0, 3.0, 37.5)],
  ["claude-opus-4-8-fast", perMillion(10.0, 50.0, 1.0, 12.5)],
  ["claude-4-sonnet-1m", perMillion(6.0, 22.5, 0.6, 7.5)],
  ["gpt-5.6-sol", perMillion(5.0, 30.0, 0.5, 6.25)],
  ["gpt-5.6-terra", perMillion(2.5, 15.0, 0.25, 3.125)],
  ["gpt-5.6-luna", perMillion(1.0, 6.0, 0.1, 1.25)],
]);

/**
 * When a `-fast` slug has no dedicated rate, multiply the base model's rates.
 * Matches OpenUsage's fast_multipliers for common GPT families.
 */
const FAST_MULTIPLIERS: ReadonlyMap<string, number> = new Map([
  ["gpt-5", 2],
  ["gpt-5.1-codex", 2],
  ["gpt-5.1-codex-max", 2],
  ["gpt-5.2", 2],
  ["gpt-5.2-codex", 2],
  ["gpt-5.3-codex", 2],
  ["gpt-5.4", 2],
  ["gpt-5.5", 2.5],
  ["gpt-5.6-sol", 2.5],
  ["gpt-5.6-terra", 2.5],
  ["gpt-5.6-luna", 2.5],
]);

/**
 * Ordered Cursor CSV / CLI slug → canonical pricing key rules (OpenUsage).
 * First match wins.
 */
const ALIAS_RULES: readonly { readonly pattern: RegExp; readonly canonical: string }[] = [
  { pattern: /^agent_review$/, canonical: "gpt-5.4" },
  { pattern: /^default$/, canonical: "auto" },
  { pattern: /^auto$/, canonical: "auto" },
  { pattern: /^composer-1$/, canonical: "composer-1" },
  { pattern: /^composer-1\.5$/, canonical: "composer-1.5" },
  { pattern: /^composer-2$/, canonical: "composer-2" },
  { pattern: /^composer-2-fast$/, canonical: "composer-2-fast" },
  { pattern: /^composer-2\.5$/, canonical: "composer-2.5" },
  { pattern: /^composer-2\.5-fast$/, canonical: "composer-2.5-fast" },
  { pattern: /^grok-build(?:-0\.1)?$/, canonical: "grok-build-0.1" },
  { pattern: /^grok-code-fast-1$/, canonical: "grok-build-0.1" },
  { pattern: /^grok-composer-2\.5-fast$/, canonical: "composer-2.5-fast" },
  {
    pattern: /^(?:cursor-)?grok-4\.5(?:-(?:low|medium|high|xhigh))?-fast$/,
    canonical: "grok-4.5-fast",
  },
  {
    pattern: /^(?:cursor-)?grok-4\.5-fast(?:-(?:low|medium|high|xhigh))?$/,
    canonical: "grok-4.5-fast",
  },
  {
    pattern: /^(?:cursor-)?grok-4\.5(?:-(?:low|medium|high|xhigh))?$/,
    canonical: "grok-4.5",
  },
  { pattern: /^kimi-k2\.7(?:-code)?$/, canonical: "kimi-k2.7-code" },
  { pattern: /^kimi-k2p7(?:-code)?$/, canonical: "kimi-k2.7-code" },
  { pattern: /^claude-4\.5-haiku(?:-thinking)?$/, canonical: "claude-haiku-4-5" },
  {
    pattern: /^claude-4\.5-opus-(?:low|medium|high)(?:-thinking)?$/,
    canonical: "claude-opus-4-5",
  },
  { pattern: /^claude-4-sonnet-1m(?:-thinking)?$/, canonical: "claude-4-sonnet-1m" },
  { pattern: /^claude-4-sonnet(?:-thinking)?$/, canonical: "claude-sonnet-4-20250514" },
  { pattern: /^claude-4\.5-sonnet(?:-thinking)?$/, canonical: "claude-sonnet-4-5" },
  {
    pattern: /^claude-4\.6-sonnet(?:-(?:low|medium|high|xhigh|max))?(?:-thinking)?$/,
    canonical: "claude-sonnet-4-6",
  },
  {
    pattern: /^claude-4\.6-opus-(?:low|medium|high|max)(?:-thinking)?-fast$/,
    canonical: "claude-opus-4-6",
  },
  {
    pattern: /^claude-4\.6-opus-(?:low|medium|high|max)(?:-thinking)?$/,
    canonical: "claude-opus-4-6",
  },
  {
    pattern: /^claude-4\.7-opus-(?:low|medium|high|max)(?:-thinking)?-fast$/,
    canonical: "claude-opus-4-7-fast",
  },
  {
    pattern: /^claude-4\.7-opus-(?:low|medium|high|max)(?:-thinking)?$/,
    canonical: "claude-opus-4-7",
  },
  {
    pattern: /^claude-opus-4-7(?:-thinking)?(?:-(?:low|medium|high|xhigh|max))?-fast$/,
    canonical: "claude-opus-4-7-fast",
  },
  {
    pattern: /^claude-opus-4-7(?:-thinking)?(?:-(?:low|medium|high|xhigh|max))?$/,
    canonical: "claude-opus-4-7",
  },
  {
    pattern: /^claude-opus-4-8(?:-thinking)?(?:-(?:low|medium|high|xhigh|max))?-fast$/,
    canonical: "claude-opus-4-8-fast",
  },
  {
    pattern: /^claude-opus-4-8(?:-thinking)?(?:-(?:low|medium|high|xhigh|max))?$/,
    canonical: "claude-opus-4-8",
  },
  {
    pattern: /^claude-fable-5(?:-thinking)?(?:-(?:low|medium|high|xhigh|max))?$/,
    canonical: "claude-fable-5",
  },
  {
    pattern: /^claude-sonnet-5(?:-thinking)?(?:-(?:low|medium|high|xhigh|max))?$/,
    canonical: "claude-sonnet-5",
  },
  { pattern: /^gemini-3-flash(?:-preview)?$/, canonical: "gemini-3-flash-preview" },
  { pattern: /^gemini-3\.1-pro(?:-preview)?$/, canonical: "gemini-3.1-pro-preview" },
  { pattern: /^gpt-5(?:-(?:low|high))?-fast$/, canonical: "gpt-5-fast" },
  { pattern: /^gpt-5(?:-(?:low|high))?$/, canonical: "gpt-5" },
  { pattern: /^gpt-5\.1(?:-(?:low|high))?-fast$/, canonical: "gpt-5-fast" },
  { pattern: /^gpt-5\.1(?:-(?:low|high))?$/, canonical: "gpt-5" },
  {
    pattern: /^gpt-5\.1-codex-max(?:-(?:low|medium|high|xhigh))?-fast$/,
    canonical: "gpt-5.1-codex-max-fast",
  },
  {
    pattern: /^gpt-5\.1-codex-max(?:-(?:low|medium|high|xhigh))?$/,
    canonical: "gpt-5.1-codex-max",
  },
  {
    pattern: /^gpt-5\.1-codex(?:-(?:low|medium|high|xhigh))?-fast$/,
    canonical: "gpt-5.1-codex-fast",
  },
  {
    pattern: /^gpt-5\.1-codex(?:-(?:low|medium|high|xhigh))?$/,
    canonical: "gpt-5.1-codex",
  },
  { pattern: /^gpt-5\.2-codex(?:-(?:low|high|xhigh))?-fast$/, canonical: "gpt-5.2-codex-fast" },
  { pattern: /^gpt-5\.2-codex(?:-(?:low|high|xhigh))?$/, canonical: "gpt-5.2-codex" },
  { pattern: /^gpt-5\.2(?:-(?:low|high|xhigh))?-fast$/, canonical: "gpt-5.2-fast" },
  { pattern: /^gpt-5\.2(?:-(?:low|high|xhigh))?$/, canonical: "gpt-5.2" },
  { pattern: /^gpt-5\.3-codex(?:-(?:low|high|xhigh))?-fast$/, canonical: "gpt-5.3-codex-fast" },
  { pattern: /^gpt-5\.3-codex(?:-(?:low|high|xhigh))?$/, canonical: "gpt-5.3-codex" },
  { pattern: /^gpt-5\.4-(?:low|medium|high|xhigh)-fast$/, canonical: "gpt-5.4-fast" },
  { pattern: /^gpt-5\.4-(?:low|medium|high|xhigh)$/, canonical: "gpt-5.4" },
  { pattern: /^gpt-5\.4-mini(?:-(?:none|low|medium|high|xhigh))?$/, canonical: "gpt-5.4-mini" },
  { pattern: /^gpt-5\.4-nano(?:-(?:none|low|medium|high|xhigh))?$/, canonical: "gpt-5.4-nano" },
  {
    pattern: /^gpt-5\.5(?:-(?:low|medium|high|xhigh|extra-high))?-fast$/,
    canonical: "gpt-5.5-fast",
  },
  {
    pattern: /^gpt-5\.5(?:-(?:low|medium|high|xhigh|extra-high))?$/,
    canonical: "gpt-5.5",
  },
  {
    pattern: /^gpt-5\.6-sol(?:-(?:none|low|medium|high|xhigh|max|ultra))?-fast$/,
    canonical: "gpt-5.6-sol-fast",
  },
  {
    pattern: /^gpt-5\.6-sol(?:-(?:none|low|medium|high|xhigh|max|ultra))?$/,
    canonical: "gpt-5.6-sol",
  },
  {
    pattern: /^gpt-5\.6-terra(?:-(?:none|low|medium|high|xhigh|max))?-fast$/,
    canonical: "gpt-5.6-terra-fast",
  },
  {
    pattern: /^gpt-5\.6-terra(?:-(?:none|low|medium|high|xhigh|max))?$/,
    canonical: "gpt-5.6-terra",
  },
  {
    pattern: /^gpt-5\.6-luna(?:-(?:none|low|medium|high|xhigh|max))?-fast$/,
    canonical: "gpt-5.6-luna-fast",
  },
  {
    pattern: /^gpt-5\.6-luna(?:-(?:none|low|medium|high|xhigh|max))?$/,
    canonical: "gpt-5.6-luna",
  },
];

/**
 * Projects the LiteLLM document into a rate table.
 *
 * Entries without both an input and an output rate are dropped: a half-priced
 * model would silently under-report cost, which is worse than reporting the
 * model as unpriced. Zero/zero stubs (OpenRouter `auto`) are skipped so the
 * Cursor supplement can supply a real rate.
 */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (typeof document !== "object" || document === null) return table;

  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as LiteLlmEntry;
    const input = finiteNumber(entry.input_cost_per_token);
    const output = finiteNumber(entry.output_cost_per_token);
    if (input === null || output === null) continue;
    if (input === 0 && output === 0) continue;

    table.set(normalizeModelName(name), {
      inputCostPerToken: input,
      outputCostPerToken: output,
      // Anthropic bills cache reads at a discount and cache writes at a
      // premium. When a model omits them, cached input is priced as plain
      // input rather than as free.
      cacheReadCostPerToken: finiteNumber(entry.cache_read_input_token_cost) ?? input,
      cacheCreationCostPerToken: finiteNumber(entry.cache_creation_input_token_cost) ?? input,
    });
  }
  return table;
}

/**
 * Canonicalises a model name for lookup.
 *
 * Strips a `provider/` prefix (LiteLLM publishes both `claude-opus-5` and
 * `anthropic/claude-opus-5`) and lowercases, since transcripts are inconsistent
 * about casing.
 */
export function normalizeModelName(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * Models we never price, regardless of the table.
 *
 * `<synthetic>` marks locally generated messages that were never billed. Bare
 * family names ("opus", "sonnet") are genuinely ambiguous across generations,
 * so we report them as unpriced instead of guessing a generation.
 */
const UNPRICEABLE_MODELS = new Set([
  "<synthetic>",
  "synthetic",
  "opus",
  "sonnet",
  "haiku",
  "fable",
]);

/** Maps a transcript / CSV model slug onto the pricing-table key. */
export function resolvePricingModelKey(model: string): string {
  const normalized = normalizeModelName(model);
  for (const rule of ALIAS_RULES) {
    if (rule.pattern.test(normalized)) return rule.canonical;
  }
  return normalized;
}

function scaleRate(rate: ModelRate, multiplier: number): ModelRate {
  return {
    inputCostPerToken: rate.inputCostPerToken * multiplier,
    outputCostPerToken: rate.outputCostPerToken * multiplier,
    cacheReadCostPerToken: rate.cacheReadCostPerToken * multiplier,
    cacheCreationCostPerToken: rate.cacheCreationCostPerToken * multiplier,
  };
}

function rateFromTables(table: RateTable, key: string): ModelRate | null {
  return SUPPLEMENT_RATES.get(key) ?? table.get(key) ?? null;
}

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  const normalized = normalizeModelName(model);
  if (normalized.length === 0 || UNPRICEABLE_MODELS.has(normalized)) return null;

  const key = resolvePricingModelKey(normalized);
  const direct = rateFromTables(table, key);
  if (direct !== null) return direct;

  // `foo-fast` with no dedicated entry → base rate × published fast multiplier.
  if (key.endsWith("-fast")) {
    const base = key.slice(0, -"-fast".length);
    const baseRate = rateFromTables(table, base);
    if (baseRate !== null) {
      return scaleRate(baseRate, FAST_MULTIPLIERS.get(base) ?? 2);
    }
  }

  // Original slug may still hit LiteLLM when no alias matched usefully.
  if (key !== normalized) {
    return rateFromTables(table, normalized);
  }
  return null;
}

export interface PricedUsage {
  readonly costUsd: number;
  readonly costSource: UsageCostSource;
}

/**
 * Prices a bucket's tokens.
 *
 * `reasoningTokens` is intentionally not charged separately: it is already
 * counted inside `outputTokens`.
 */
export function priceUsage(
  table: RateTable,
  model: string,
  totals: UsageTokenTotals,
  reportedCostUsd: number | null,
): PricedUsage {
  if (reportedCostUsd !== null && Number.isFinite(reportedCostUsd)) {
    return { costUsd: reportedCostUsd, costSource: "providerReported" };
  }

  const rate = lookupRate(table, model);
  if (rate === null) return { costUsd: 0, costSource: "unpriced" };

  const costUsd =
    totals.uncachedInputTokens * rate.inputCostPerToken +
    totals.cachedInputTokens * rate.cacheReadCostPerToken +
    totals.cacheCreationTokens * rate.cacheCreationCostPerToken +
    totals.outputTokens * rate.outputCostPerToken;

  return { costUsd, costSource: "modelPriced" };
}

/**
 * What the cached input would have cost at full input rates, minus what it
 * actually cost. Drives the "cache savings" figure.
 */
export function cacheSavingsUsd(table: RateTable, model: string, totals: UsageTokenTotals): number {
  const rate = lookupRate(table, model);
  if (rate === null) return 0;
  return totals.cachedInputTokens * (rate.inputCostPerToken - rate.cacheReadCostPerToken);
}
