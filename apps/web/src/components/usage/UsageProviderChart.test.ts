import { describe, expect, it } from "vite-plus/test";

import { buildPeriodColumns } from "./UsageProviderChart";

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
          ["claude" as const, { costUsd: 20, totalTokens: 200, reasoningTokens: 40 }],
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

  it("shows thinking within token totals without changing the cost series", () => {
    const tokens = buildPeriodColumns(days, byDay, "tokens");
    expect(tokens.map((column) => column.total)).toEqual([420, 0, 50]);
    expect(tokens[0]?.bands.find((band) => band.provider === "claude")).toEqual({
      provider: "claude",
      value: 200,
      thinking: 40,
    });
    expect(tokens[0]?.bands.find((band) => band.provider === "codex")?.thinking).toBe(0);
    expect(tokens[1]?.bands.every((band) => band.thinking === 0)).toBe(true);
    const cost = buildPeriodColumns(days, byDay, "cost");
    expect(cost.map((column) => column.total)).toEqual([42, 0, 5]);
    expect(cost[0]?.bands.every((band) => band.thinking === 0)).toBe(true);
  });

  it("keeps band values absolute rather than cumulative", () => {
    const [first] = buildPeriodColumns(days, byDay, "cost");

    expect(first?.bands).toEqual([
      { provider: "codex", value: 10, thinking: 0 },
      { provider: "claude", value: 20, thinking: 0 },
      { provider: "grok", value: 0, thinking: 0 },
      { provider: "cursor", value: 0, thinking: 0 },
      { provider: "opencode", value: 0, thinking: 0 },
      { provider: "antigravity", value: 0, thinking: 0 },
      { provider: "pi", value: 5, thinking: 0 },
      { provider: "muse", value: 7, thinking: 0 },
    ]);
  });
});
