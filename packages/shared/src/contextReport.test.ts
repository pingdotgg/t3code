import { describe, expect, it } from "vite-plus/test";

import type {
  OrchestrationV2ProviderTurnTokenUsage,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";

import {
  contextReportFromUsage,
  contextUsedCategories,
  formatContextHeadline,
  formatContextPercent,
  parseContextReport,
  type ContextReport,
} from "./contextReport.ts";

describe("contextReportFromUsage", () => {
  it("shows current Codex usage with exact counts and reported counters", () => {
    const usage: ThreadTokenUsageSnapshot = {
      usedTokens: 64_600,
      maxTokens: 258_400,
      totalProcessedTokens: 999_000,
      inputTokens: 60_000,
      outputTokens: 4_600,
      cachedInputTokens: 50_000,
      reasoningOutputTokens: 1_200,
    };
    const report = contextReportFromUsage(usage, "gpt-6.1-sol");
    expect(report).toEqual({
      model: "gpt-6.1-sol",
      usedTokens: "65k",
      maxTokens: "258k",
      usedPercent: 25,
      overLimit: null,
      categories: [
        { name: "Used context", tokens: "65k", percent: 25 },
        { name: "Free space", tokens: "194k", percent: 75 },
      ],
      sections: [
        {
          title: "Exact token counts",
          columns: ["Category", "Tokens"],
          rows: [
            ["Used context", "64,600"],
            ["Free space", "193,800"],
            ["Context window", "258,400"],
          ],
          totalTokens: null,
        },
        {
          title: "Reported usage",
          columns: ["Counter", "Tokens"],
          rows: [
            ["Input", "60,000"],
            ["Cached input", "50,000"],
            ["Output", "4,600"],
            ["Reasoning", "1,200"],
          ],
          totalTokens: null,
        },
      ],
    });
    expect(formatContextHeadline(report!)).toBe("65k / 258k (25%)");
    expect(contextUsedCategories(report!).map((category) => category.name)).toEqual([
      "Used context",
    ]);
  });

  it("shows only capacity counts when a harness reports no counters", () => {
    const usage: OrchestrationV2ProviderTurnTokenUsage = {
      usedTokens: 40_000,
      maxTokens: 200_000,
      updatedAt: "2026-10-04T12:00:00.000Z",
    };
    const report = contextReportFromUsage(usage);
    expect(report).toMatchObject({ usedPercent: 20 });
    expect(report?.sections.map((section) => section.title)).toEqual(["Exact token counts"]);
    expect(contextReportFromUsage({ ...usage, maxTokens: null })).toBeNull();
  });

  it("keeps counters larger than the context out of the occupancy breakdown", () => {
    const report = contextReportFromUsage({
      usedTokens: 30_000,
      maxTokens: 100_000,
      inputTokens: 900_000,
      outputTokens: 80_000,
    });
    expect(report?.categories.map((category) => [category.name, category.percent])).toEqual([
      ["Used context", 30],
      ["Free space", 70],
    ]);
    expect(report?.sections[1]?.rows).toEqual([
      ["Input", "900,000"],
      ["Output", "80,000"],
    ]);
  });

  it("keeps zero usage and clamps free space when over the limit", () => {
    expect(
      contextReportFromUsage({ usedTokens: 0, maxTokens: 200_000, reasoningOutputTokens: 0 }),
    ).toMatchObject({
      usedTokens: "0",
      usedPercent: 0,
      model: null,
      categories: [
        { name: "Used context", tokens: "0", percent: 0 },
        { name: "Free space", tokens: "200k", percent: 100 },
      ],
      sections: [
        {
          rows: [
            ["Used context", "0"],
            ["Free space", "200,000"],
            ["Context window", "200,000"],
          ],
        },
        { rows: [["Reasoning", "0"]] },
      ],
    });
    expect(contextReportFromUsage({ usedTokens: 210_000, maxTokens: 200_000 })).toMatchObject({
      usedPercent: 105,
      overLimit: "10k tokens over",
      categories: [{ percent: 105 }, { tokens: "0", percent: 0 }],
      sections: [
        {
          rows: [
            ["Used context", "210,000"],
            ["Free space", "0"],
            ["Context window", "200,000"],
          ],
        },
      ],
    });
  });

  it.each([
    undefined,
    null,
    { usedTokens: 1_000 },
    { usedTokens: 1_000, maxTokens: null },
    { usedTokens: 1_000, maxTokens: 0 },
    { usedTokens: 1_000, maxTokens: -1 },
    { usedTokens: 1_000, maxTokens: Number.POSITIVE_INFINITY },
    { usedTokens: 1_000, maxTokens: 100.5 },
    { usedTokens: -1, maxTokens: 200_000 },
    { usedTokens: Number.NaN, maxTokens: 200_000 },
    { usedTokens: 100.5, maxTokens: 200_000 },
  ])("returns null for unavailable or invalid bounds: %j", (usage) => {
    expect(contextReportFromUsage(usage)).toBeNull();
  });
});

describe("normalized reports", () => {
  it("formats reports from other harnesses with their own categories and tables", () => {
    const report: ContextReport = {
      model: "other-model",
      usedTokens: "40k",
      maxTokens: "100k",
      usedPercent: 40,
      overLimit: null,
      categories: [
        { name: "Instructions", tokens: "10k", percent: 10 },
        { name: "Conversation", tokens: "30k", percent: 30 },
        { name: "Free space", tokens: "60k", percent: 60 },
      ],
      sections: [{ title: "Files", columns: ["Path"], rows: [["AGENTS.md"]], totalTokens: null }],
    };
    expect(formatContextHeadline(report)).toBe("40k / 100k (40%)");
    expect(contextUsedCategories(report).map((category) => category.name)).toEqual([
      "Instructions",
      "Conversation",
    ]);
  });
});

describe("text reports", () => {
  const text = "## Context Usage\n\n**Tokens:** 10k / 200k (5%)";

  it("uses the Claude adapter and preserves unrecognized Markdown", () => {
    expect(parseContextReport(text)).toMatchObject({ usedTokens: "10k", usedPercent: 5 });
    expect(parseContextReport(`${text}\nExplanation`)).toBeNull();
    expect(parseContextReport("Context: 10k / 200k")).toBeNull();
  });
});

describe("formatContextPercent", () => {
  it.each([
    [0, "0%"],
    [0.2, "0.2%"],
    [9.54, "9.5%"],
    [40.5, "41%"],
    [105, "105%"],
  ])("formats %d as %s", (value, expected) => {
    expect(formatContextPercent(value)).toBe(expected);
  });
});
