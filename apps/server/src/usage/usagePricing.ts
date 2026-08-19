/**
 * Model rate lookup and cost arithmetic.
 *
 * Rates come from LiteLLM's `model_prices_and_context_window.json`, the same
 * table `ccusage` prices against, plus Cursor-published rates for Auto /
 * Composer / Grok (export slugs that LiteLLM does not carry). Everything here
 * is pure: fetching and caching the table lives in `UsageService`.
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

/** Builds a rate from Cursor/docs "$ per million tokens" figures. */
function ratePerMillion(
  input: number,
  output: number,
  cacheRead: number = input,
  cacheWrite: number = input,
): ModelRate {
  return {
    inputCostPerToken: input / 1_000_000,
    outputCostPerToken: output / 1_000_000,
    cacheReadCostPerToken: cacheRead / 1_000_000,
    cacheCreationCostPerToken: cacheWrite / 1_000_000,
  };
}

/**
 * Cursor-native rates (docs: Auto Cost, Composer, Grok 4.5).
 *
 * Export model names are product slugs, not LiteLLM ids. Prefer these over a
 * colliding LiteLLM row (e.g. OpenRouter `auto` at $0/$0).
 *
 * Auto Balance / Intelligence bill at the routed model — the CSV does not say
 * which mode ran, so Auto Cost is the honest flat rate for the `auto` label.
 */
const CURSOR_AUTO_COST = ratePerMillion(1.25, 6, 0.25, 1.25);
const CURSOR_COMPOSER_2 = ratePerMillion(0.5, 2.5);
const CURSOR_COMPOSER_2_FAST = ratePerMillion(1.5, 7.5);
const CURSOR_COMPOSER_2_5 = ratePerMillion(0.5, 2.5);
const CURSOR_COMPOSER_2_5_FAST = ratePerMillion(3, 15);
const CURSOR_GROK_4_5 = ratePerMillion(2, 6, 0.5, 2);
const CURSOR_GROK_4_5_FAST = ratePerMillion(4, 18, 1, 4);

/**
 * Cursor effort / thinking / fast suffixes baked into export model names.
 * Longest-first so `-thinking-high` wins over `-high`.
 */
const CURSOR_PARAM_SUFFIXES = [
  "-thinking-high",
  "-high-thinking",
  "-thinking",
  "-fast-xhigh",
  "-high-fast",
  "-low-fast",
  "-xhigh",
  "-high",
  "-medium",
  "-low",
  "-fast",
] as const;

/**
 * Projects the LiteLLM document into a rate table.
 *
 * Entries without both an input and an output rate are dropped: a half-priced
 * model would silently under-report cost, which is worse than reporting the
 * model as unpriced. Zero/zero rows (OpenRouter `auto`) are also dropped so
 * they cannot mask a later Cursor-native rate.
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
 * Strips Cursor parameter suffixes (`-thinking-high`, `-medium`, `-fast`, …)
 * so export slugs can hit LiteLLM base model ids.
 */
function stripCursorModelParams(model: string): string {
  let name = normalizeModelName(model);
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of CURSOR_PARAM_SUFFIXES) {
      if (name.endsWith(suffix)) {
        name = name.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  return name;
}

/**
 * Alternate LiteLLM keys for Cursor / transcript naming variants
 * (`claude-4.5-sonnet` ↔ `claude-sonnet-4-5`).
 */
function modelLookupCandidates(model: string): readonly string[] {
  const normalized = normalizeModelName(model);
  const stripped = stripCursorModelParams(normalized);
  const candidates: string[] = [];
  const push = (name: string) => {
    if (name.length > 0 && !candidates.includes(name)) candidates.push(name);
  };

  push(normalized);
  push(stripped);

  for (const base of [normalized, stripped]) {
    const familyVersion = /^claude-(\d+(?:\.\d+)?)-(opus|sonnet|haiku)$/.exec(base);
    if (familyVersion) {
      const version = familyVersion[1]!;
      const family = familyVersion[2]!;
      const dashed = version.replaceAll(".", "-");
      push(`claude-${family}-${dashed}`);
      push(`claude-${dashed}-${family}`);
      push(`claude-${family}-${version}`);
    }

    const opusVersion = /^claude-opus-(\d+(?:\.\d+)?)$/.exec(base);
    if (opusVersion) {
      const version = opusVersion[1]!;
      const dashed = version.replaceAll(".", "-");
      push(`claude-opus-${dashed}`);
      push(`claude-${dashed}-opus`);
      push(`claude-opus-${version}`);
    }
  }

  return candidates;
}

function cursorNativeRate(normalized: string): ModelRate | null {
  switch (normalized) {
    case "auto":
      return CURSOR_AUTO_COST;
    case "composer-2.5-fast":
      return CURSOR_COMPOSER_2_5_FAST;
    case "composer-2.5":
      return CURSOR_COMPOSER_2_5;
    case "composer-2-fast":
      return CURSOR_COMPOSER_2_FAST;
    case "composer-2":
      return CURSOR_COMPOSER_2;
    default:
      break;
  }

  const withoutCursorPrefix = normalized.startsWith("cursor-")
    ? normalized.slice("cursor-".length)
    : normalized;
  if (withoutCursorPrefix.startsWith("grok-4.5")) {
    return withoutCursorPrefix.includes("fast") ? CURSOR_GROK_4_5_FAST : CURSOR_GROK_4_5;
  }

  return null;
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
  const normalized = normalizeModelName(model);
  if (normalized.length === 0 || UNPRICEABLE_MODELS.has(normalized)) return null;

  // Cursor product rates win over LiteLLM collisions (notably `auto`).
  // Only the exact export slug is checked — never a stripped candidate — so
  // `composer-2.5-fast` cannot fall through to standard Composer rates.
  const native = cursorNativeRate(normalized);
  if (native !== null) return native;

  for (const candidate of modelLookupCandidates(normalized)) {
    const fromTable = table.get(candidate);
    if (fromTable) return fromTable;
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
