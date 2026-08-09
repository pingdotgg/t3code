import { describe, expect, it } from "vite-plus/test";

import { buildDayColumns, formatChartValue, niceScale } from "./UsageProviderChart";

describe("niceScale", () => {
  it("never puts the peak above the top of the scale", () => {
    // Regression: an earlier version stopped at the last step below the peak,
    // so the tallest day was drawn past the plot and clipped.
    for (const peak of [1122.71, 999, 1, 0.04, 1_400_000_000, 37.5, 5000, 100.001]) {
      const { max } = niceScale(peak, 4);
      expect(max, `peak ${peak}`).toBeGreaterThanOrEqual(peak);
    }
  });

  it("starts at zero and ends at the maximum", () => {
    const { max, ticks } = niceScale(1122.71, 4);

    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeCloseTo(max, 6);
  });

  it("uses evenly spaced 1/2/5 steps", () => {
    const { ticks } = niceScale(1122.71, 4);
    const steps = ticks.slice(1).map((tick, index) => tick - (ticks[index] ?? 0));

    for (const step of steps) expect(step).toBeCloseTo(steps[0] ?? 0, 6);
    const [first = 0] = steps;
    const normalized = first / 10 ** Math.floor(Math.log10(first));
    expect([1, 2, 5, 10]).toContain(Math.round(normalized));
  });

  it("keeps the tick count near the requested resolution", () => {
    const { ticks } = niceScale(1122.71, 4);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(7);
  });

  it("degrades to a single zero tick with no data", () => {
    expect(niceScale(0, 4)).toEqual({ max: 0, ticks: [0] });
  });
});

describe("buildDayColumns", () => {
  const days = ["2026-08-01", "2026-08-02", "2026-08-03"];
  const byDay = new Map([
    [
      "2026-08-01",
      {
        day: "2026-08-01",
        costUsd: 30,
        totalTokens: 300,
        unpricedShare: 0.5,
        byProvider: new Map([
          ["codex" as const, { costUsd: 10, totalTokens: 100, unpricedShare: 1 }],
          ["claude" as const, { costUsd: 20, totalTokens: 200, unpricedShare: 0.25 }],
        ]),
      },
    ],
    // 2026-08-02 is deliberately absent: a day with no activity.
    [
      "2026-08-03",
      {
        day: "2026-08-03",
        costUsd: 5,
        totalTokens: 50,
        unpricedShare: 0,
        byProvider: new Map([
          ["claude" as const, { costUsd: 5, totalTokens: 50, unpricedShare: 0 }],
        ]),
      },
    ],
  ]);

  it("plots each day on its own", () => {
    expect(buildDayColumns(days, byDay, "cost").map((column) => column.total)).toEqual([30, 0, 5]);
  });

  it("reads the requested metric", () => {
    expect(buildDayColumns(days, byDay, "tokens").map((column) => column.total)).toEqual([
      300, 0, 50,
    ]);
  });

  it("retains pricing coverage for cost hover values", () => {
    const [first] = buildDayColumns(days, byDay, "cost");

    expect(first).toMatchObject({
      unpricedShare: 0.5,
      bands: [
        { provider: "codex", unpricedShare: 1 },
        { provider: "claude", unpricedShare: 0.25 },
      ],
    });
  });

  it("retains whether sparse provider-day columns have activity", () => {
    const columns = buildDayColumns(days, byDay, "cost");

    expect(columns[1]).toMatchObject({
      hasActivity: false,
      bands: [
        { provider: "codex", hasActivity: false },
        { provider: "claude", hasActivity: false },
      ],
    });
    expect(columns[2]).toMatchObject({
      hasActivity: true,
      bands: [
        { provider: "codex", hasActivity: false },
        { provider: "claude", hasActivity: true },
      ],
    });
  });

  it("keeps band values absolute rather than cumulative", () => {
    // Regression: the bands were once stack offsets, which drew Claude Code
    // permanently above Codex regardless of which provider spent more.
    const [first] = buildDayColumns(days, byDay, "cost");

    expect(first?.bands).toEqual([
      { provider: "codex", value: 10, unpricedShare: 1, hasActivity: true },
      { provider: "claude", value: 20, unpricedShare: 0.25, hasActivity: true },
    ]);
  });

  it("reports the total as the sum of its bands", () => {
    for (const column of buildDayColumns(days, byDay, "cost")) {
      const sum = column.bands.reduce((running, band) => running + band.value, 0);
      expect(column.total).toBeCloseTo(sum, 9);
    }
  });
});

describe("formatChartValue", () => {
  it("labels an inactive provider-day as no activity rather than priced zero", () => {
    expect(formatChartValue("cost", 0, 0, false)).toBe("—");
    expect(formatChartValue("cost", 0, 0, true)).toBe("$0.00");
  });

  it("does not show missing or partial cost rates as exact hover values", () => {
    expect(formatChartValue("cost", 0, 1, true)).toBe("—");
    expect(formatChartValue("cost", 20, 0.25, true)).toBe("≥$20.00");
    expect(formatChartValue("cost", 20, 0, true)).toBe("$20.00");
  });

  it("keeps token hover values independent of pricing coverage", () => {
    expect(formatChartValue("tokens", 20_000, 1, true)).toBe("20K");
  });
});
