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
import type {
  UsageCategoryCost,
  UsageCostSource,
  UsageModelPriceOverride,
  UsageTokenTotals,
} from "@t3tools/contracts";

import type { UsageRecord, UsageSpeed } from "@t3tools/provider-core/server/usage";

export interface TokenRates {
  readonly inputCostPerToken: number;
  readonly outputCostPerToken: number;
  readonly cacheReadCostPerToken: number;
  readonly cacheCreationCostPerToken: number;
}

/** Omits LiteLLM's above_272k_tokens, flex and batches variants, which transcripts do not record. */
export interface ModelRate extends TokenRates {
  readonly fast: TokenRates | null;
  readonly ultrafast: TokenRates | null;
}

export type RateTable = ReadonlyMap<string, ModelRate>;

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
        fast: null,
        ultrafast: null,
      },
    ]),
  );
}

type LiteLlmEntry = Readonly<Record<string, unknown>>;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Missing cache rates fall back to input pricing; Anthropic normally discounts reads and charges extra for writes.
function readTokenRates(
  entry: LiteLlmEntry,
  suffix: string,
  standard?: TokenRates,
): TokenRates | null {
  const input = finiteNumber(entry[`input_cost_per_token${suffix}`]);
  const output = finiteNumber(entry[`output_cost_per_token${suffix}`]);
  if (input === null || output === null) return null;
  const cacheRate = (name: string, field: "cacheReadCostPerToken" | "cacheCreationCostPerToken") =>
    finiteNumber(entry[`${name}${suffix}`]) ??
    (standard !== undefined && standard.inputCostPerToken > 0
      ? (standard[field] / standard.inputCostPerToken) * input
      : input);
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheReadCostPerToken: cacheRate("cache_read_input_token_cost", "cacheReadCostPerToken"),
    cacheCreationCostPerToken: cacheRate(
      "cache_creation_input_token_cost",
      "cacheCreationCostPerToken",
    ),
  };
}

function scaleTokenRates(rates: TokenRates, multiple: number): TokenRates {
  return {
    inputCostPerToken: rates.inputCostPerToken * multiple,
    outputCostPerToken: rates.outputCostPerToken * multiple,
    cacheReadCostPerToken: rates.cacheReadCostPerToken * multiple,
    cacheCreationCostPerToken: rates.cacheCreationCostPerToken * multiple,
  };
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
    fast: null,
    ultrafast: null,
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

/** Reads `provider_specific_entry.fast`, e.g. `2` for Claude Opus 5.5. */
function fastMultiplier(entry: LiteLlmEntry): number | null {
  const specific = entry["provider_specific_entry"];
  if (typeof specific !== "object" || specific === null) return null;
  const fast = finiteNumber((specific as Record<string, unknown>)["fast"]);
  return fast !== null && fast > 0 ? fast : null;
}

// LiteLLM prefixes for the model makers' own APIs; their price beats a cloud's or reseller's for a bare name.
const FIRST_PARTY_PROVIDERS = new Set([
  "anthropic",
  "deepseek",
  "gemini",
  "meta",
  "mistral",
  "openai",
  "xai",
]);

/**
 * Projects the LiteLLM document into a rate table.
 *
 * Entries without both an input and an output rate are dropped: a half-priced
 * model would silently under-report cost, which is worse than reporting the
 * model as unpriced. Zero/zero rows (OpenRouter `auto`) are also dropped so
 * they cannot mask a later Cursor-native rate.
 *
 * Entries keep their full normalized key; a bare name is aliased only when no
 * canonical entry exists. A model maker's own entry beats cloud and reseller
 * rows; otherwise every qualified entry must agree on the rate. That stops
 * reseller rows from marking up or mis-pricing cache reads for a bare name.
 */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (typeof document !== "object" || document === null) return table;

  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as LiteLlmEntry;
    const standard = readTokenRates(entry, "");
    if (standard === null) continue;
    if (standard.inputCostPerToken === 0 && standard.outputCostPerToken === 0) continue;

    const key = normalizeRateKey(name);
    if (key.length === 0) continue;
    const multiple = fastMultiplier(entry);
    table.set(key, {
      ...standard,
      fast:
        multiple === null
          ? readTokenRates(entry, "_priority", standard)
          : scaleTokenRates(standard, multiple),
      ultrafast: readTokenRates(entry, "_ultrafast", standard),
    });
  }

  const aliasCandidates = new Map<string, { rate: ModelRate | null; firstParty: boolean }>();
  for (const [key, rate] of table) {
    const alias = bareModelName(key);
    if (alias.length === 0 || alias === key || table.has(alias)) continue;
    const firstParty = FIRST_PARTY_PROVIDERS.has(key.slice(0, key.indexOf("/")));
    const held = aliasCandidates.get(alias);
    if (held === undefined || (firstParty && !held.firstParty)) {
      aliasCandidates.set(alias, { rate, firstParty });
    } else if (held.rate !== null && firstParty === held.firstParty) {
      aliasCandidates.set(alias, { rate: mergeAliasRate(held.rate, rate), firstParty });
    }
  }
  for (const [alias, { rate }] of aliasCandidates) {
    if (rate !== null) table.set(alias, rate);
  }

  return table;
}

function sameTokenRates(a: TokenRates | null, b: TokenRates | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.inputCostPerToken === b.inputCostPerToken &&
    a.outputCostPerToken === b.outputCostPerToken &&
    a.cacheReadCostPerToken === b.cacheReadCostPerToken &&
    a.cacheCreationCostPerToken === b.cacheCreationCostPerToken
  );
}

// Resellers often omit speed tiers, so a missing tier fills from the other entry instead of conflicting.
function mergeAliasRate(a: ModelRate, b: ModelRate): ModelRate | null {
  const fast = a.fast ?? b.fast;
  const ultrafast = a.ultrafast ?? b.ultrafast;
  if (
    !sameTokenRates(a, b) ||
    !sameTokenRates(fast, b.fast ?? fast) ||
    !sameTokenRates(ultrafast, b.ultrafast ?? ultrafast)
  ) {
    return null;
  }
  return { ...a, fast, ultrafast };
}

function ratesAt(rate: ModelRate, speed: UsageSpeed): TokenRates {
  return (speed === "standard" ? null : rate[speed]) ?? rate;
}

function normalizeRateKey(model: string): string {
  return model.trim().toLowerCase();
}

function bareModelName(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

/**
 * Strips a `provider/` prefix and lowercases, since transcripts are
 * inconsistent about casing.
 */
export function normalizeModelName(model: string): string {
  return bareModelName(normalizeRateKey(model));
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
 * Drops a bracketed variant suffix such as `claude-fable-5-1[1m]`, which
 * Claude Code writes for the 1M context tier. The rate table only knows the
 * base name, and we price at the base tier anyway.
 */
function stripVariantSuffix(key: string): string {
  const bracket = key.indexOf("[");
  return bracket === -1 ? key : key.slice(0, bracket);
}

// Synthetic messages are unbilled; bare family names are generation-ambiguous and remain unpriced.
const UNPRICEABLE_MODELS = new Set([
  "<synthetic>",
  "synthetic",
  "opus",
  "sonnet",
  "haiku",
  "fable",
]);

// Immutable tables permit caching rates across twice-per-record pricing lookups.
const resolvedRates = new WeakMap<RateTable, Map<string, ModelRate | null>>();

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  let resolved = resolvedRates.get(table);
  if (resolved === undefined) {
    resolved = new Map();
    resolvedRates.set(table, resolved);
  }
  let rate = resolved.get(model);
  if (rate === undefined) {
    rate = resolveRate(table, model);
    resolved.set(model, rate);
  }
  return rate;
}

function resolveRate(table: RateTable, model: string): ModelRate | null {
  const key = stripVariantSuffix(normalizeRateKey(model));
  const bareName = bareModelName(key);
  if (bareName.length === 0 || UNPRICEABLE_MODELS.has(bareName)) return null;

  const exact = table.get(key);
  if (exact) return exact;

  // A missing provider-qualified key must stay unpriced so reseller rows
  // cannot leak through bare aliases (upstream cache-pricing contract).
  if (key.includes("/")) return null;

  // Cursor product rates win over LiteLLM collisions (notably `auto`).
  // Only the exact export slug is checked — never a stripped candidate — so
  // `composer-2.5-fast` cannot fall through to standard Composer rates.
  const native = cursorNativeRate(bareName);
  if (native !== null) return native;

  for (const candidate of modelLookupCandidates(bareName)) {
    const fromTable = table.get(candidate);
    if (fromTable) return fromTable;
  }

  return null;
}

export type PricedRecord = Pick<
  UsageRecord,
  "model" | "rateModel" | "totals" | "speed" | "reportedCostUsd"
>;

export interface PricedUsage {
  readonly costUsd: number;
  readonly costSource: UsageCostSource;
  readonly categoryCostUsd: UsageCategoryCost | null;
  readonly speedPremiumUsd: number;
}

function costByCategory(totals: UsageTokenTotals, rates: TokenRates): UsageCategoryCost {
  return {
    input: totals.uncachedInputTokens * rates.inputCostPerToken,
    cacheRead: totals.cachedInputTokens * rates.cacheReadCostPerToken,
    cacheWrite: totals.cacheCreationTokens * rates.cacheCreationCostPerToken,
    output: totals.outputTokens * rates.outputCostPerToken,
  };
}

function sumCategories(cost: UsageCategoryCost): number {
  return cost.input + cost.cacheRead + cost.cacheWrite + cost.output;
}

/** Reasoning tokens are already included in outputTokens; do not charge twice. */
export function priceUsage(
  table: RateTable,
  record: PricedRecord,
  overrides?: RateTable,
): PricedUsage {
  const { model, totals, reportedCostUsd } = record;
  const override = overrides?.get(model.trim());
  const reported =
    override === undefined && reportedCostUsd !== null && Number.isFinite(reportedCostUsd)
      ? reportedCostUsd
      : null;
  const unsplit = (costUsd: number, costSource: UsageCostSource): PricedUsage => ({
    costUsd,
    costSource,
    categoryCostUsd: null,
    speedPremiumUsd: 0,
  });
  const rate = override ?? lookupRate(table, record.rateModel ?? model);
  if (rate === null) {
    return reported === null ? unsplit(0, "unpriced") : unsplit(reported, "providerReported");
  }

  const listCost = costByCategory(totals, ratesAt(rate, record.speed));
  const listCostUsd = sumCategories(listCost);
  if (reported !== null && listCostUsd <= 0) return unsplit(reported, "providerReported");
  const premiumUsd =
    record.speed === "standard" ? 0 : listCostUsd - sumCategories(costByCategory(totals, rate));
  const scale = reported === null ? 1 : reported / listCostUsd;
  return {
    costUsd: reported ?? listCostUsd,
    costSource: reported === null ? "modelPriced" : "providerReported",
    categoryCostUsd: {
      input: listCost.input * scale,
      cacheRead: listCost.cacheRead * scale,
      cacheWrite: listCost.cacheWrite * scale,
      output: listCost.output * scale,
    },
    speedPremiumUsd: premiumUsd * scale,
  };
}

export function cacheSavingsUsd(
  table: RateTable,
  record: PricedRecord,
  overrides?: RateTable,
): number {
  const rate =
    overrides?.get(record.model.trim()) ?? lookupRate(table, record.rateModel ?? record.model);
  if (rate === null) return 0;
  const rates = ratesAt(rate, record.speed);
  return record.totals.cachedInputTokens * (rates.inputCostPerToken - rates.cacheReadCostPerToken);
}
