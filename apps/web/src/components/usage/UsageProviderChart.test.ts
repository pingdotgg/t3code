import { describe, expect, it } from "vite-plus/test";

import { formatCurrencyCompact } from "@t3tools/shared/usageFormat";
import { buildDayColumns, niceScale } from "./UsageProviderChart";

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

  it("produces distinct compact labels for zero-decimal currency ticks", () => {
    const labels = niceScale(2000, 4).ticks.map((tick) => formatCurrencyCompact(tick, "JPY"));

    expect(new Set(labels).size).toBe(labels.length);
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
        byProvider: new Map([
          ["codex" as const, { costUsd: 10, totalTokens: 100 }],
          ["claude" as const, { costUsd: 20, totalTokens: 200 }],
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
        byProvider: new Map([["claude" as const, { costUsd: 5, totalTokens: 50 }]]),
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

  it("keeps band values absolute rather than cumulative", () => {
    // Regression: the bands were once stack offsets, which drew Claude Code
    // permanently above Codex regardless of which provider spent more.
    const [first] = buildDayColumns(days, byDay, "cost");

    expect(first?.bands).toEqual([
      { provider: "codex", value: 10 },
      { provider: "claude", value: 20 },
    ]);
  });

  it("reports the total as the sum of its bands", () => {
    for (const column of buildDayColumns(days, byDay, "cost")) {
      const sum = column.bands.reduce((running, band) => running + band.value, 0);
      expect(column.total).toBeCloseTo(sum, 9);
    }
  });

  it("converts cost into display units before banding", () => {
    // Regression: nicening in USD then FX-formatting ticks produced labels like
    // €692.9 for an $800 gridline. Convert first so the scale is round in-currency.
    expect(buildDayColumns(days, byDay, "cost", (usd) => usd * 0.5).map((c) => c.total)).toEqual([
      15, 0, 2.5,
    ]);
  });

  it("leaves token values unconverted", () => {
    expect(buildDayColumns(days, byDay, "tokens", (usd) => usd * 0.5).map((c) => c.total)).toEqual([
      300, 0, 50,
    ]);
  });
});

describe("currency-aware cost scale", () => {
  it("nicens after conversion so axis ticks stay round", () => {
    const peakUsd = 800;
    const eurRate = 0.866;
    // Converted USD ticks would be 692.8 / 519.6 / …; nicening in EUR first
    // should land on a clean 1/2/5 step instead.
    expect(niceScale(peakUsd * eurRate, 4).ticks).toEqual([0, 200, 400, 600, 800]);
  });

  it("formats low-cost axis ticks with distinct labels", () => {
    const { ticks } = niceScale(0.04, 4);
    const labels = ticks
      .filter((tick) => tick > 0)
      .map((tick) => formatCurrencyCompact(tick, "USD"));

    expect(labels.length).toBeGreaterThan(1);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
