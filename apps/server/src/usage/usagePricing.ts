/**
 * Model rate lookup and cost arithmetic.
 *
 * Rates come from LiteLLM's `model_prices_and_context_window.json`, the same
 * table `ccusage` prices against. Everything here is pure: fetching and caching
 * the table lives in `UsageService`.
 *
 * @module usagePricing
 */
import type {
  UsageCostSource,
  UsageModelPriceOverride,
  UsageTokenTotals,
} from "@t3tools/contracts";

/**
 * The subset of a LiteLLM entry we price against. All values are USD per token.
 *
 * LiteLLM also publishes context-length tiers (`*_above_272k_tokens`) and
 * service tiers (`*_flex`, `*_priority`, `*_batches`). Transcript token counts
 * determine the context-length tier; service tiers remain unknown and use
 * their base public-list rates.
 */
interface TokenRate {
  readonly inputCostPerToken: number;
  readonly outputCostPerToken: number;
  readonly cacheReadCostPerToken: number;
  readonly cacheCreationCostPerToken: number;
  readonly cacheCreation1hCostPerToken?: number;
}

interface LongContextRate extends TokenRate {
  readonly thresholdTokens: number;
}

export interface ModelRate extends TokenRate {
  readonly longContextRates?: readonly LongContextRate[];
}

export type RateTable = ReadonlyMap<string, ModelRate>;

/** Custom IDs keep their case, provider prefix, and variant suffix. */
export function createOverrideRateTable(
  overrides: Readonly<Record<string, UsageModelPriceOverride>>,
): RateTable {
  return new Map(
    Object.entries(overrides).map(([model, prices]) => [
      model.trim(),
      {
        inputCostPerToken: prices.inputCostPerMillionTokens / 1_000_000,
        outputCostPerToken: prices.outputCostPerMillionTokens / 1_000_000,
        cacheReadCostPerToken:
          (prices.cacheReadCostPerMillionTokens ?? prices.inputCostPerMillionTokens) / 1_000_000,
        cacheCreationCostPerToken:
          (prices.cacheWriteCostPerMillionTokens ?? prices.inputCostPerMillionTokens) / 1_000_000,
      },
    ]),
  );
}

/** Raw shape of one LiteLLM entry, narrowed to the fields we read. */
interface LiteLlmEntry extends Record<string, unknown> {
  readonly input_cost_per_token?: unknown;
  readonly output_cost_per_token?: unknown;
  readonly cache_read_input_token_cost?: unknown;
  readonly cache_creation_input_token_cost?: unknown;
  readonly cache_creation_input_token_cost_above_1hr?: unknown;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseLongContextRates(entry: LiteLlmEntry, base: TokenRate): readonly LongContextRate[] {
  const thresholds = new Set<number>();
  for (const field of Object.keys(entry)) {
    const match = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(field);
    const thousands = Number(match?.[1]);
    if (Number.isSafeInteger(thousands) && thousands > 0) thresholds.add(thousands * 1000);
  }

  return [...thresholds]
    .sort((left, right) => left - right)
    .flatMap((thresholdTokens) => {
      const suffix = `${thresholdTokens / 1000}k_tokens`;
      const input = finiteNumber(entry[`input_cost_per_token_above_${suffix}`]);
      const output = finiteNumber(entry[`output_cost_per_token_above_${suffix}`]);
      if (input === null || output === null) return [];
      const cacheCreation1hCostPerToken =
        finiteNumber(entry[`cache_creation_input_token_cost_above_1hr_above_${suffix}`]) ??
        base.cacheCreation1hCostPerToken;
      return [
        {
          thresholdTokens,
          inputCostPerToken: input,
          outputCostPerToken: output,
          cacheReadCostPerToken:
            finiteNumber(entry[`cache_read_input_token_cost_above_${suffix}`]) ??
            base.cacheReadCostPerToken,
          cacheCreationCostPerToken:
            finiteNumber(entry[`cache_creation_input_token_cost_above_${suffix}`]) ??
            base.cacheCreationCostPerToken,
          ...(cacheCreation1hCostPerToken === undefined ? {} : { cacheCreation1hCostPerToken }),
        },
      ];
    });
}

/**
 * Projects the LiteLLM document into a rate table.
 *
 * Entries without both an input and an output rate are dropped: a half-priced
 * model would silently under-report cost, which is worse than reporting the
 * model as unpriced.
 *
 * Entries keep their full normalized key; a bare name is aliased only when no
 * canonical entry exists and every qualified entry has the same rate.
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

    const key = normalizeRateKey(name);
    if (key.length === 0) continue;
    const base: TokenRate = {
      inputCostPerToken: input,
      outputCostPerToken: output,
      // Anthropic bills cache reads at a discount and cache writes at a
      // premium. When a model omits them, cached input is priced as plain
      // input rather than as free.
      cacheReadCostPerToken: finiteNumber(entry.cache_read_input_token_cost) ?? input,
      cacheCreationCostPerToken: finiteNumber(entry.cache_creation_input_token_cost) ?? input,
      cacheCreation1hCostPerToken:
        finiteNumber(entry.cache_creation_input_token_cost_above_1hr) ??
        finiteNumber(entry.cache_creation_input_token_cost) ??
        input,
    };
    const longContextRates = parseLongContextRates(entry, base);
    table.set(key, {
      ...base,
      ...(longContextRates.length === 0 ? {} : { longContextRates }),
    });
  }

  // `null` marks a bare name claimed at conflicting rates: no alias for it.
  const aliasCandidates = new Map<string, ModelRate | null>();
  for (const [key, rate] of table) {
    const alias = bareModelName(key);
    if (alias.length === 0 || alias === key || table.has(alias)) continue;
    const held = aliasCandidates.get(alias);
    if (held === undefined) {
      aliasCandidates.set(alias, rate);
    } else if (held !== null && !sameRate(held, rate)) {
      aliasCandidates.set(alias, null);
    }
  }
  for (const [alias, rate] of aliasCandidates) {
    if (rate !== null) table.set(alias, rate);
  }

  return table;
}

function sameRate(a: ModelRate, b: ModelRate): boolean {
  if (!sameTokenRate(a, b)) return false;
  const aLong = a.longContextRates ?? [];
  const bLong = b.longContextRates ?? [];
  return (
    aLong.length === bLong.length &&
    aLong.every((rate, index) => {
      const other = bLong[index];
      return (
        other !== undefined &&
        rate.thresholdTokens === other.thresholdTokens &&
        sameTokenRate(rate, other)
      );
    })
  );
}

function sameTokenRate(a: TokenRate, b: TokenRate): boolean {
  return (
    a.inputCostPerToken === b.inputCostPerToken &&
    a.outputCostPerToken === b.outputCostPerToken &&
    a.cacheReadCostPerToken === b.cacheReadCostPerToken &&
    a.cacheCreationCostPerToken === b.cacheCreationCostPerToken &&
    a.cacheCreation1hCostPerToken === b.cacheCreation1hCostPerToken
  );
}

function normalizeRateKey(model: string): string {
  return model.trim().toLowerCase();
}

function bareModelName(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

/**
 * Drops a bracketed variant suffix such as `claude-fable-5-1[1m]`, which
 * Claude Code writes for the 1M context tier. The rate table only knows the
 * base name, and we price at the base tier anyway.
 */
function stripVariantSuffix(key: string): string {
  const bracket = key.indexOf("[");
  return bracket === -1 ? key : key.slice(0, bracket);
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

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  const key = stripVariantSuffix(normalizeRateKey(model));
  const bareName = bareModelName(key);
  if (bareName.length === 0 || UNPRICEABLE_MODELS.has(bareName)) return null;
  return table.get(key) ?? null;
}

export interface PricedUsage {
  readonly costUsd: number;
  readonly costSource: UsageCostSource;
}

function rateForTotals(rate: ModelRate, totals: UsageTokenTotals): TokenRate {
  const inputTokens =
    totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens;
  let selected: TokenRate = rate;
  for (const tier of rate.longContextRates ?? []) {
    if (inputTokens <= tier.thresholdTokens) break;
    selected = tier;
  }
  return selected;
}

function applicableRate(
  table: RateTable,
  model: string,
  totals: UsageTokenTotals,
  overrides?: RateTable,
): TokenRate | null {
  const rate = overrides?.get(model.trim()) ?? lookupRate(table, model);
  return rate === null ? null : rateForTotals(rate, totals);
}

function cacheCreationCost(totals: UsageTokenTotals, rate: TokenRate): number {
  const oneHour = Math.min(
    totals.cacheCreationTokens,
    Math.max(0, totals.cacheCreation1hTokens ?? 0),
  );
  const fiveMinute = Math.min(
    totals.cacheCreationTokens - oneHour,
    Math.max(0, totals.cacheCreation5mTokens ?? 0),
  );
  const unclassified = totals.cacheCreationTokens - fiveMinute - oneHour;
  return (
    (unclassified + fiveMinute) * rate.cacheCreationCostPerToken +
    oneHour * (rate.cacheCreation1hCostPerToken ?? rate.cacheCreationCostPerToken)
  );
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
  overrides?: RateTable,
): PricedUsage {
  const override = overrides?.get(model.trim());
  if (override === undefined && reportedCostUsd !== null && Number.isFinite(reportedCostUsd)) {
    return { costUsd: reportedCostUsd, costSource: "providerReported" };
  }

  const rate = applicableRate(table, model, totals, overrides);
  if (rate === null) return { costUsd: 0, costSource: "unpriced" };

  const costUsd =
    totals.uncachedInputTokens * rate.inputCostPerToken +
    totals.cachedInputTokens * rate.cacheReadCostPerToken +
    cacheCreationCost(totals, rate) +
    totals.outputTokens * rate.outputCostPerToken;

  return { costUsd, costSource: "modelPriced" };
}

/**
 * What the cached input would have cost at full input rates, minus what it
 * actually cost. Drives the "cache savings" figure.
 */
export function cacheSavingsUsd(
  table: RateTable,
  model: string,
  totals: UsageTokenTotals,
  overrides?: RateTable,
): number {
  const rate = applicableRate(table, model, totals, overrides);
  if (rate === null) return 0;
  return totals.cachedInputTokens * (rate.inputCostPerToken - rate.cacheReadCostPerToken);
}

/**
 * Estimates what this usage's cache writes cost at the model and TTL-specific rates.
 * Cache creation is a billing category, not proof of an expiry rewrite.
 */
export function cacheWriteUsd(
  table: RateTable,
  model: string,
  totals: UsageTokenTotals,
  overrides?: RateTable,
): number {
  const rate = applicableRate(table, model, totals, overrides);
  if (rate === null) return 0;
  return cacheCreationCost(totals, rate);
}

export interface UsageComponentCosts {
  readonly cacheWriteUsd: number;
  readonly cacheReadUsd: number;
  /** Fresh input plus output. */
  readonly freshUsd: number;
}

const ZERO_COMPONENT_COSTS: UsageComponentCosts = {
  cacheWriteUsd: 0,
  cacheReadUsd: 0,
  freshUsd: 0,
};

/**
 * Splits model-priced usage into cache writes, cache reads, and everything
 * else. Unpriced models contribute nothing here; token totals still include
 * them.
 */
export function usageComponentCosts(
  table: RateTable,
  model: string,
  totals: UsageTokenTotals,
  overrides?: RateTable,
): UsageComponentCosts {
  const rate = applicableRate(table, model, totals, overrides);
  if (rate === null) return ZERO_COMPONENT_COSTS;
  return {
    cacheWriteUsd: cacheCreationCost(totals, rate),
    cacheReadUsd: totals.cachedInputTokens * rate.cacheReadCostPerToken,
    freshUsd:
      totals.uncachedInputTokens * rate.inputCostPerToken +
      totals.outputTokens * rate.outputCostPerToken,
  };
}
