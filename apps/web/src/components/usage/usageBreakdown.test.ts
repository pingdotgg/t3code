import type { DailyTotals, HourlyTotals, ModelTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { cacheHitRate, costPerMillionTokens, timeBreakdownMetric } from "./usageBreakdown";

describe("time breakdown metric", () => {
  const daily: DailyTotals = {
    day: "2026-10-22",
    costUsd: 3.5,
    totalTokens: 2_500_000,
    byProvider: new Map([
      ["codex", { costUsd: 3.5, totalTokens: 2_000_000 }],
      ["opencode", { costUsd: 0, totalTokens: 500_000 }],
    ]),
  };
  const hourly: HourlyTotals = { ...daily, hourStart: "2026-10-22T10:00:00.000Z" };

  it.each([
    { resolution: "day", period: daily },
    { resolution: "hour", period: hourly },
  ])("switches $resolution provider and total figures with the selected metric", ({ period }) => {
    for (const metric of ["cost", "tokens", "cost"] as const) {
      const figures = timeBreakdownMetric(metric);
      expect(figures.formatValue(period.byProvider.get("codex"))).toBe(
        metric === "tokens" ? "2M" : "$3.50",
      );
      expect(figures.formatValue(period.byProvider.get("opencode"))).toBe(
        metric === "tokens" ? "500K" : "$0.00",
      );
      expect(figures.formatValue(period)).toBe(metric === "tokens" ? "2.50M" : "$3.50");
      expect(figures.secondaryLabel).toBe(metric === "tokens" ? "Cost" : "Tokens");
      expect(figures.formatSecondaryValue(period)).toBe(metric === "tokens" ? "$3.50" : "2.50M");
    }
  });

  it("shows zero for a provider with no activity in the period", () => {
    const missing = hourly.byProvider.get("claude");
    expect(timeBreakdownMetric("cost").formatValue(missing)).toBe("$0.00");
    expect(timeBreakdownMetric("tokens").formatValue(missing)).toBe("0");
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
