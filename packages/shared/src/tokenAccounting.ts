import type { ThreadTokenUsageSnapshot, ThreadUsageCostSnapshot } from "@t3tools/contracts";

export type TokenContentKind = "natural" | "code" | "diff" | "markup" | "mixed";

export interface ModelPricingCatalogEntry {
  readonly provider?: string;
  readonly model: string;
  readonly pricingVersion?: string;
  readonly inputPerMillionUsd?: number;
  readonly uncachedInputPerMillionUsd?: number;
  readonly cachedInputPerMillionUsd?: number;
  readonly cacheCreationInputPerMillionUsd?: number;
  readonly cacheReadInputPerMillionUsd?: number;
  readonly outputPerMillionUsd?: number;
  readonly reasoningOutputPerMillionUsd?: number;
}

export interface ModelPricingCatalog {
  readonly entries: ReadonlyArray<ModelPricingCatalogEntry>;
}

function clampNonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

function isCjkHeavy(text: string): boolean {
  if (text.length === 0) return false;
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/gu)?.length ?? 0;
  return cjk / text.length > 0.2;
}

export function estimateTextTokens(input: {
  readonly text: string;
  readonly contentKind?: TokenContentKind;
}): number {
  const text = input.text ?? "";
  if (text.length === 0) return 0;
  if (isCjkHeavy(text)) {
    return clampNonNegativeInteger(text.length * 0.8);
  }
  const divisor =
    input.contentKind === "code" || input.contentKind === "diff" || input.contentKind === "markup"
      ? 3.2
      : input.contentKind === "mixed"
        ? 3.4
        : 3.7;
  return clampNonNegativeInteger(text.length / divisor);
}

export function estimateImageTokens(input: {
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
}): number {
  if (input.width && input.height && input.width > 0 && input.height > 0) {
    const tiles = Math.ceil(input.width / 512) * Math.ceil(input.height / 512);
    return Math.max(85, tiles * 170);
  }
  return clampNonNegativeInteger(input.sizeBytes / 3072);
}

export function deriveCacheStats(usage: ThreadTokenUsageSnapshot): {
  readonly cachedInputTokens: number | null;
  readonly uncachedInputTokens: number | null;
  readonly cacheHitRatio: number | null;
} {
  const cachedInputTokens =
    usage.cachedInputTokens ??
    (usage.cacheCreationInputTokens !== undefined || usage.cacheReadInputTokens !== undefined
      ? (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0)
      : null);
  const uncachedInputTokens =
    usage.uncachedInputTokens ??
    (usage.inputTokens !== undefined && cachedInputTokens !== null
      ? Math.max(0, usage.inputTokens - cachedInputTokens)
      : null);
  const denominator =
    cachedInputTokens !== null && uncachedInputTokens !== null
      ? cachedInputTokens + uncachedInputTokens
      : usage.inputTokens;
  const cacheHitRatio =
    cachedInputTokens !== null && denominator !== undefined && denominator > 0
      ? cachedInputTokens / denominator
      : null;
  return { cachedInputTokens, uncachedInputTokens, cacheHitRatio };
}

function cost(
  tokens: number | undefined,
  ratePerMillionUsd: number | undefined,
): number | undefined {
  if (tokens === undefined || ratePerMillionUsd === undefined) return undefined;
  return (tokens / 1_000_000) * ratePerMillionUsd;
}

function findPricing(input: {
  readonly provider: string;
  readonly model?: string;
  readonly pricingCatalog: ModelPricingCatalog;
}): ModelPricingCatalogEntry | undefined {
  if (!input.model) return undefined;
  return input.pricingCatalog.entries.find(
    (entry) =>
      entry.model === input.model &&
      (entry.provider === undefined || entry.provider === input.provider),
  );
}

export function computeUsageCost(input: {
  readonly provider: string;
  readonly model?: string;
  readonly serviceTier?: string;
  readonly usage: ThreadTokenUsageSnapshot;
  readonly providerReportedTotalCostUsd?: number;
  readonly pricingCatalog: ModelPricingCatalog;
}): ThreadUsageCostSnapshot | undefined {
  if (
    input.providerReportedTotalCostUsd !== undefined &&
    Number.isFinite(input.providerReportedTotalCostUsd)
  ) {
    return {
      currency: "USD",
      totalCostUsd: input.providerReportedTotalCostUsd,
      source: "provider",
      confidence: "exact",
      ...(input.model ? { model: input.model } : {}),
      ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
      components: [
        {
          category: "provider_reported_total",
          costUsd: input.providerReportedTotalCostUsd,
        },
      ],
    };
  }

  const pricing = findPricing(input);
  if (!pricing) return undefined;

  const components: Array<ThreadUsageCostSnapshot["components"][number]> = [];
  const push = (
    category: ThreadUsageCostSnapshot["components"][number]["category"],
    tokens: number | undefined,
    ratePerMillionUsd: number | undefined,
  ) => {
    const componentCost = cost(tokens, ratePerMillionUsd);
    if (componentCost === undefined || tokens === undefined) return;
    components.push({ category, tokens, ratePerMillionUsd, costUsd: componentCost });
  };

  push(
    "uncached_input",
    input.usage.uncachedInputTokens,
    pricing.uncachedInputPerMillionUsd ?? pricing.inputPerMillionUsd,
  );
  push("cached_input", input.usage.cachedInputTokens, pricing.cachedInputPerMillionUsd);
  push(
    "cache_creation_input",
    input.usage.cacheCreationInputTokens,
    pricing.cacheCreationInputPerMillionUsd,
  );
  push("cache_read_input", input.usage.cacheReadInputTokens, pricing.cacheReadInputPerMillionUsd);

  if (!components.some((component) => component.category.endsWith("input"))) {
    push("input", input.usage.inputTokens, pricing.inputPerMillionUsd);
  }
  push("output", input.usage.outputTokens, pricing.outputPerMillionUsd);
  push("reasoning_output", input.usage.reasoningOutputTokens, pricing.reasoningOutputPerMillionUsd);

  if (components.length === 0) return undefined;
  return {
    currency: "USD",
    totalCostUsd: components.reduce((sum, component) => sum + component.costUsd, 0),
    source: "builtin-pricing",
    confidence: "medium",
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    ...(pricing.pricingVersion ? { pricingVersion: pricing.pricingVersion } : {}),
    components,
  };
}
