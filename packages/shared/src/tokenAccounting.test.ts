import { describe, expect, it } from "vite-plus/test";

import { computeUsageCost, deriveCacheStats, estimateTextTokens } from "./tokenAccounting.ts";

const approx = (value: number, expected: number) => expect(value).toBeCloseTo(expected, 6);

describe("tokenAccounting", () => {
  it("estimates code-like text more densely than natural text", () => {
    const text = "a".repeat(370);
    expect(estimateTextTokens({ text, contentKind: "natural" })).toBe(100);
    expect(estimateTextTokens({ text, contentKind: "code" })).toBe(116);
  });

  it("derives cache stats from explicit cached and uncached inputs", () => {
    expect(
      deriveCacheStats({
        usedTokens: 1400,
        inputTokens: 1000,
        uncachedInputTokens: 250,
        cachedInputTokens: 750,
      }),
    ).toEqual({ cachedInputTokens: 750, uncachedInputTokens: 250, cacheHitRatio: 0.75 });
  });

  it("derives cache stats from provider cache creation/read fields", () => {
    expect(
      deriveCacheStats({
        usedTokens: 1200,
        inputTokens: 1000,
        cacheCreationInputTokens: 400,
        cacheReadInputTokens: 100,
      }),
    ).toEqual({ cachedInputTokens: 500, uncachedInputTokens: 500, cacheHitRatio: 0.5 });
  });

  it("uses provider-reported cost as exact total", () => {
    expect(
      computeUsageCost({
        provider: "claudeAgent",
        model: "claude-sonnet-5",
        usage: { usedTokens: 1000 },
        providerReportedTotalCostUsd: 0.123,
        pricingCatalog: { entries: [] },
      }),
    ).toMatchObject({
      totalCostUsd: 0.123,
      source: "provider",
      confidence: "exact",
      components: [{ category: "provider_reported_total", costUsd: 0.123 }],
    });
  });

  it("computes component costs from a pricing catalog", () => {
    const result = computeUsageCost({
      provider: "codex",
      model: "gpt-example",
      usage: {
        usedTokens: 5000,
        uncachedInputTokens: 1000,
        cachedInputTokens: 2000,
        outputTokens: 500,
      },
      pricingCatalog: {
        entries: [
          {
            provider: "codex",
            model: "gpt-example",
            uncachedInputPerMillionUsd: 2,
            cachedInputPerMillionUsd: 0.5,
            outputPerMillionUsd: 8,
          },
        ],
      },
    });

    expect(result?.source).toBe("builtin-pricing");
    approx(result?.totalCostUsd ?? 0, 0.007);
  });
});
