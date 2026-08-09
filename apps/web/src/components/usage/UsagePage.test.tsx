import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { DailyTotals, ModelTotals, ProviderTotals } from "@t3tools/shared/usageMerge";
import { formatUsageMetricLabel, UsageBreakdownTable, UsageProviderRows } from "./UsagePage";

function provider(overrides: Partial<ProviderTotals> = {}): ProviderTotals {
  return {
    provider: "codex",
    costUsd: 0,
    totalTokens: 10_000,
    records: 1,
    costShare: 0,
    tokenShare: 1,
    unpricedShare: 1,
    ...overrides,
  };
}

function model(overrides: Partial<ModelTotals> = {}): ModelTotals {
  return {
    provider: "codex",
    model: "gpt-5.6-sol",
    costUsd: 12.34,
    totalTokens: 10_000,
    records: 4,
    costShare: 0.6,
    unpricedShare: 0.25,
    ...overrides,
  };
}

function day(overrides: Partial<DailyTotals> = {}): DailyTotals {
  return {
    day: "2026-08-01",
    costUsd: 0,
    totalTokens: 10_000,
    unpricedShare: 1,
    byProvider: new Map([["codex", { costUsd: 0, totalTokens: 10_000, unpricedShare: 1 }]]),
    ...overrides,
  };
}

describe("formatUsageMetricLabel", () => {
  it("marks the web cost headline partial when pricing coverage is incomplete", () => {
    expect(formatUsageMetricLabel("cost", 0.25)).toBe("Raw token cost (partial)");
    expect(formatUsageMetricLabel("cost", 0)).toBe("Raw token cost");
    expect(formatUsageMetricLabel("tokens", 1)).toBe("Processed tokens");
  });
});

describe("UsageProviderRows", () => {
  it("does not assign a priced-cost share to a fully unpriced provider", () => {
    const markup = renderToStaticMarkup(
      <UsageProviderRows providers={[provider()]} metric="cost" totalUnpricedShare={1} />,
    );

    expect(markup).toContain("No priced-cost share · 100.0% unpriced · 10K tokens");
    expect(markup).not.toContain("0.0% of priced cost");
  });

  it("does not call fully unpriced provider usage free in token mode", () => {
    const markup = renderToStaticMarkup(
      <UsageProviderRows providers={[provider()]} metric="tokens" totalUnpricedShare={1} />,
    );

    expect(markup).toContain("100.0% of tokens · —");
    expect(markup).not.toContain("$0.00");
  });

  it("labels partial bars against priced cost", () => {
    const markup = renderToStaticMarkup(
      <UsageProviderRows
        providers={[provider({ costUsd: 12.34, costShare: 0.6, unpricedShare: 0.25 })]}
        metric="cost"
        totalUnpricedShare={0.25}
      />,
    );

    expect(markup).toContain("≥$12.34");
    expect(markup).toContain("60.0% of priced cost · 25.0% unpriced");
  });

  it("keeps the ordinary cost-share wording when every record is priced", () => {
    const markup = renderToStaticMarkup(
      <UsageProviderRows
        providers={[provider({ costUsd: 12.34, costShare: 0.6, unpricedShare: 0 })]}
        metric="cost"
        totalUnpricedShare={0}
      />,
    );

    expect(markup).toContain("$12.34");
    expect(markup).toContain("60.0% of cost · 10K tokens");
    expect(markup).not.toContain("priced cost");
    expect(markup).not.toContain("unpriced");
  });
});

describe("UsageBreakdownTable", () => {
  it("visibly explains partial estimates and describes the model table", () => {
    const markup = renderToStaticMarkup(
      <UsageBreakdownTable
        breakdown="model"
        models={[model()]}
        recentDays={[]}
        totalUnpricedShare={0.25}
      />,
    );

    expect(markup).toContain("≥ means a lower-bound estimate from matching API rates");
    expect(markup).toContain("— means no matching rate");
    expect(markup).toContain('aria-describedby="usage-cost-guidance"');
    expect(markup).toContain("Share of priced cost");
    expect(markup).toContain("≥$12.34");
  });

  it("describes all-unpriced day values without calling them zero cost", () => {
    const markup = renderToStaticMarkup(
      <UsageBreakdownTable
        breakdown="day"
        models={[]}
        recentDays={[day()]}
        totalUnpricedShare={1}
      />,
    );

    expect(markup).toContain('aria-describedby="usage-cost-guidance"');
    expect(markup).toContain("— means no matching rate");
    expect(markup).toContain("No matching API rates; token totals are still complete.");
  });

  it("labels an absent provider-day as no activity rather than priced zero", () => {
    const markup = renderToStaticMarkup(
      <UsageBreakdownTable
        breakdown="day"
        models={[]}
        recentDays={[day()]}
        totalUnpricedShare={1}
      />,
    );

    expect(markup).toContain('title="No activity">—</span>');
    expect(markup).not.toContain("If billed at full API rate.");
    expect(markup).not.toContain("$0.00");
  });

  it("keeps all-priced model details free of partial-estimate guidance", () => {
    const markup = renderToStaticMarkup(
      <UsageBreakdownTable
        breakdown="model"
        models={[model({ unpricedShare: 0 })]}
        recentDays={[]}
        totalUnpricedShare={0}
      />,
    );

    expect(markup).toContain(">Share</th>");
    expect(markup).not.toContain("Share of priced cost");
    expect(markup).not.toContain("usage-cost-guidance");
    expect(markup).not.toContain("lower-bound estimate");
  });
});
