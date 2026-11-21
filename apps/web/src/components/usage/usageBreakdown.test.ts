import type { DailyTotals, ModelTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { cacheHitRate, costPerMillionTokens, timeBreakdownMetric } from "./usageBreakdown";

describe("time breakdown metric", () => {
  const period: DailyTotals = {
    day: "2026-10-22",
    costUsd: 3.5,
    totalTokens: 2_500_000,
    byProvider: new Map([["codex", { costUsd: 3.5, totalTokens: 2_500_000 }]]),
  };

  it.each([
    {
      metric: "cost",
      value: "$3.50",
      missing: "$0.00",
      secondaryLabel: "Tokens",
      secondary: "2.50M",
    },
    { metric: "tokens", value: "2.50M", missing: "0", secondaryLabel: "Cost", secondary: "$3.50" },
  ] as const)("shows $metric figures with the other metric trailing", (row) => {
    const figures = timeBreakdownMetric(row.metric);
    expect(figures.formatValue(period.byProvider.get("codex"))).toBe(row.value);
    expect(figures.formatValue(period.byProvider.get("claude"))).toBe(row.missing);
    expect(figures.formatValue(period)).toBe(row.value);
    expect(figures.secondaryLabel).toBe(row.secondaryLabel);
    expect(figures.formatSecondaryValue(period)).toBe(row.secondary);
  });
});

const model = (
  name: string,
  totalTokens: number,
  costUsd: number,
  overrides: Partial<ModelTotals> = {},
): ModelTotals => ({
  model: name,
  provider: "codex",
  costUsd,
  totalTokens,
  tokens: {
    uncachedInputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  },
  records: 1,
  unpricedRecords: 0,
  unpricedTokens: 0,
  costShare: 0,
  tokenShare: 0,
  ...overrides,
});

describe("model rates", () => {
  it("counts cache writes as misses and leaves unpriced tokens out of $/1M", () => {
    const mixed = model("mixed", 4_000_000, 6, {
      tokens: {
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheCreationTokens: 2_000_000,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      records: 4,
      unpricedRecords: 1,
      unpricedTokens: 1_000_000,
    });

    expect(cacheHitRate(mixed)).toBe(0.25);
    expect(costPerMillionTokens(mixed)).toBe(2);
    expect(costPerMillionTokens({ ...mixed, unpricedRecords: 4 })).toBeNull();
  });
});
