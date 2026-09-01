/**
 * Model rate lookup and cost arithmetic.
 *
 * Rates come from LiteLLM's `model_prices_and_context_window.json`, the same
 * table `ccusage` prices against. Everything here is pure: fetching and caching
 * the table lives in `UsageService`.
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
  readonly cacheCreation1hCostPerToken?: number;
}

export type RateTable = ReadonlyMap<string, ModelRate>;

/** Raw shape of one LiteLLM entry, narrowed to the fields we read. */
interface LiteLlmEntry {
  readonly input_cost_per_token?: unknown;
  readonly output_cost_per_token?: unknown;
  readonly cache_read_input_token_cost?: unknown;
  readonly cache_creation_input_token_cost?: unknown;
  readonly cache_creation_input_token_cost_above_1hr?: unknown;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
    table.set(key, {
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

/**
 * Canonicalises a model name for lookup.
 *
 * Strips a `provider/` prefix and lowercases, since transcripts are
 * inconsistent about casing.
 */
export function normalizeModelName(model: string): string {
  return bareModelName(normalizeRateKey(model));
}

function bareModelName(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
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
  const key = normalizeRateKey(model);
  const bareName = bareModelName(key);
  if (bareName.length === 0 || UNPRICEABLE_MODELS.has(bareName)) return null;
  return table.get(key) ?? null;
}

export interface PricedUsage {
  readonly costUsd: number;
  readonly costSource: UsageCostSource;
}

function cacheCreationCost(totals: UsageTokenTotals, rate: ModelRate): number {
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
): PricedUsage {
  if (reportedCostUsd !== null && Number.isFinite(reportedCostUsd)) {
    return { costUsd: reportedCostUsd, costSource: "providerReported" };
  }

  const rate = lookupRate(table, model);
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
export function cacheSavingsUsd(table: RateTable, model: string, totals: UsageTokenTotals): number {
  const rate = lookupRate(table, model);
  if (rate === null) return 0;
  return totals.cachedInputTokens * (rate.inputCostPerToken - rate.cacheReadCostPerToken);
}

/**
 * Estimates what this usage's cache writes cost at the model and TTL-specific rates.
 * Cache creation is a billing category, not proof of an expiry rewrite.
 */
export function cacheWriteUsd(table: RateTable, model: string, totals: UsageTokenTotals): number {
  const rate = lookupRate(table, model);
  if (rate === null) return 0;
  return cacheCreationCost(totals, rate);
}

export interface UsageComponentCosts {
  readonly cacheWriteUsd: number;
  readonly cacheReadUsd: number;
  /** Fresh input plus output. */
  readonly freshUsd: number;
}

const ZERO_COMPONENTS: UsageComponentCosts = { cacheWriteUsd: 0, cacheReadUsd: 0, freshUsd: 0 };

/**
 * Splits model-priced usage into cache writes, cache reads, and everything
 * else. Unpriced models contribute nothing here; token totals still include
 * them.
 */
export function usageComponentCosts(
  table: RateTable,
  model: string,
  totals: UsageTokenTotals,
): UsageComponentCosts {
  const rate = lookupRate(table, model);
  if (rate === null) return ZERO_COMPONENTS;
  return {
    cacheWriteUsd: cacheCreationCost(totals, rate),
    cacheReadUsd: totals.cachedInputTokens * rate.cacheReadCostPerToken,
    freshUsd:
      totals.uncachedInputTokens * rate.inputCostPerToken +
      totals.outputTokens * rate.outputCostPerToken,
  };
}
