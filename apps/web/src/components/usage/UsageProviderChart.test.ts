import { describe, expect, it } from "vite-plus/test";

import { buildPeriodColumns, formatChartDay } from "./UsageProviderChart";

describe("formatChartDay", () => {
  it.each([
    { days: ["2026-01-01", "2026-12-31"], label: "Jan 1" },
    { days: ["2025-12-31", "2026-01-01"], label: "Jan 1, 2026" },
    { days: ["2024-01-01", "2026-01-01"], label: "Jan 1, 2026" },
    { days: ["2026-01-01"], label: "Jan 1" },
  ])("formats dates across $days", ({ days, label }) => {
    expect(formatChartDay("2026-01-01", days)).toBe(label);
  });
});

describe("buildPeriodColumns", () => {
  const days = ["2026-08-01", "2026-08-02", "2026-08-03"];
  const byDay = new Map([
    [
      "2026-08-01",
      {
        day: "2026-08-01",
        costUsd: 42,
        totalTokens: 420,
        byProvider: new Map([
          ["codex" as const, { costUsd: 10, totalTokens: 100 }],
          ["claude" as const, { costUsd: 20, totalTokens: 200 }],
          ["pi" as const, { costUsd: 5, totalTokens: 50 }],
          ["muse" as const, { costUsd: 7, totalTokens: 70 }],
        ]),
      },
    ],
    [
      "2026-08-03",
      {
        day: "2026-08-03",
        costUsd: 5,
        totalTokens: 50,
        byProvider: new Map([["claude" as const, { costUsd: 5, totalTokens: 50 }]]),
      },
    ],
  ]);

  it("keeps band values absolute rather than cumulative", () => {
    const [first] = buildPeriodColumns(days, byDay, "cost");

    expect(first?.bands).toEqual([
      { provider: "codex", value: 10 },
      { provider: "claude", value: 20 },
      { provider: "grok", value: 0 },
      { provider: "cursor", value: 0 },
      { provider: "opencode", value: 0 },
      { provider: "antigravity", value: 0 },
      { provider: "pi", value: 5 },
      { provider: "muse", value: 7 },
    ]);
  });
});
