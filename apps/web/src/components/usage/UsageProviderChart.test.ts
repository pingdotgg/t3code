import { describe, expect, it } from "vite-plus/test";

import { buildChart, buildPeriodColumns } from "./UsageProviderChart";

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
  it("stacks provider values and scales bars to their combined total", () => {
    const chart = buildChart(days, byDay, "cost", ["codex", "claude", "pi"], new Set(), "bar");
    const [codex, claude, pi] = chart.bars;

    expect(chart.scale.max).toBe(40);
    expect(chart.bars).toHaveLength(4);
    expect(codex).toMatchObject({ provider: "codex", x: 32, width: 256, y: 197, height: 63 });
    expect(claude).toMatchObject({ provider: "claude", y: 71, height: 126 });
    expect(pi).toMatchObject({ provider: "pi", y: 39.5, height: 31.5 });
    expect(chart.bars[3]).toMatchObject({ period: days[2], x: 672 });
    expect(chart.stepX).toBe(320);
    expect(chart.offsetX).toBe(160);
    expect(chart.paths).toEqual([]);
  });

  it("keeps area series independent and excludes hidden providers from bar totals", () => {
    const area = buildChart(days, byDay, "cost", ["codex", "claude", "pi"], new Set(), "area");
    expect(area.scale.max).toBe(20);
    expect(area.bars).toEqual([]);
    expect(area.paths.map((path) => path.provider)).toEqual(["claude", "codex", "pi"]);
    const filtered = buildChart(days, byDay, "tokens", ["codex"], new Set(), "bar");
    expect(filtered.scale.max).toBe(100);
    expect(filtered.columns[0]?.total).toBe(100);
    expect(filtered.bars).toHaveLength(1);
    expect(filtered.bars[0]).toMatchObject({ provider: "codex", y: 8, height: 252 });
  });

  it("handles empty and loading bar charts without invalid geometry", () => {
    const empty = buildChart([], new Map(), "cost", [], new Set(), "bar");
    expect(empty.bars).toEqual([]);
    expect(empty.scale.max).toBe(0);
    const loading = buildChart(days, new Map(), "cost", ["codex"], new Set(["codex"]), "bar");
    expect(loading.scale.labeled).toBe(false);
    expect(loading.bars).toEqual([]);
  });
});
