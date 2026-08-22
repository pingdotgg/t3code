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
}

/**
 * Parsed pricing data with source models kept separate from derived aliases.
 *
 * Keeping these indexes distinct prevents a convenience alias from inflating
 * the model count or being mistaken for an exact provider-qualified entry.
 */
export interface RateTable {
  readonly exactRates: ReadonlyMap<string, ModelRate>;
  readonly bareAliases: ReadonlyMap<string, ModelRate>;
  readonly modelCount: number;
}

export function emptyRateTable(): RateTable {
  return { exactRates: new Map(), bareAliases: new Map(), modelCount: 0 };
}

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

/**
 * Projects the LiteLLM document into a rate table.
 *
 * Entries without both an input and an output rate are dropped: a half-priced
 * model would silently under-report cost, which is worse than reporting the
 * model as unpriced. Provider-qualified keys remain distinct. A bare alias is
 * added only for a canonical entry or one unambiguous provider candidate.
 */
export function parseRateTable(document: unknown): RateTable {
  const candidatesByKey = new Map<
    string,
    Array<{ readonly rawName: string; readonly rate: ModelRate }>
  >();
  if (typeof document !== "object" || document === null) return emptyRateTable();

  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as LiteLlmEntry;
    const input = finiteNumber(entry.input_cost_per_token);
    const output = finiteNumber(entry.output_cost_per_token);
    if (input === null || output === null) continue;

    const key = normalizeRateKey(name);
    if (key.length === 0) continue;
    const rate = {
      inputCostPerToken: input,
      outputCostPerToken: output,
      // Anthropic bills cache reads at a discount and cache writes at a
      // premium. When a model omits them, cached input is priced as plain
      // input rather than as free.
      cacheReadCostPerToken: finiteNumber(entry.cache_read_input_token_cost) ?? input,
      cacheCreationCostPerToken: finiteNumber(entry.cache_creation_input_token_cost) ?? input,
    };
    const candidates = candidatesByKey.get(key) ?? [];
    candidates.push({ rawName: name, rate });
    candidatesByKey.set(key, candidates);
  }

  const exactRates = new Map<string, ModelRate>();
  for (const [key, candidates] of candidatesByKey) {
    const selected = selectExactCandidate(key, candidates);
    if (selected !== null) exactRates.set(key, selected.rate);
  }

  const candidatesByAlias = new Map<
    string,
    Array<{ readonly key: string; readonly rate: ModelRate }>
  >();
  for (const [key, rate] of exactRates) {
    const alias = normalizeModelName(key);
    const candidates = candidatesByAlias.get(alias) ?? [];
    candidates.push({ key, rate });
    candidatesByAlias.set(alias, candidates);
  }

  const bareAliases = new Map<string, ModelRate>();
  for (const [alias, candidates] of candidatesByAlias) {
    const canonical = candidates.find((candidate) => candidate.key === alias);
    if (canonical === undefined && candidates.length === 1) {
      const [candidate] = candidates;
      if (candidate !== undefined) bareAliases.set(alias, candidate.rate);
    }
  }

  return { exactRates, bareAliases, modelCount: exactRates.size };
}

/**
 * Selects one source entry after normalization.
 *
 * A collision is only resolved when one entry has the canonical normalized
 * spelling verbatim. Otherwise neither variant has trustworthy provenance, so
 * dropping the key is safer than making pricing depend on document order.
 */
function selectExactCandidate(
  key: string,
  candidates: readonly { readonly rawName: string; readonly rate: ModelRate }[],
): { readonly rawName: string; readonly rate: ModelRate } | null {
  if (candidates.length === 1) return candidates[0] ?? null;
  return candidates.find((candidate) => candidate.rawName === key) ?? null;
}

export function rateTableModelCount(table: RateTable): number {
  return table.modelCount;
}

function normalizeRateKey(model: string): string {
  return model.trim().toLowerCase();
}

/**
 * Canonicalises a model name for lookup.
 *
 * Strips a `provider/` prefix and lowercases. This derives a candidate bare
 * alias; exact provider-qualified lookup uses the normalized full key first.
 */
export function normalizeModelName(model: string): string {
  const trimmed = normalizeRateKey(model);
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

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  const exact = normalizeRateKey(model);
  const normalized = normalizeModelName(model);
  if (normalized.length === 0 || UNPRICEABLE_MODELS.has(normalized)) return null;
  if (exact.includes("/")) return table.exactRates.get(exact) ?? null;
  return table.exactRates.get(exact) ?? table.bareAliases.get(exact) ?? null;
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
