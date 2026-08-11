import { describe, expect, it } from "vite-plus/test";

import type { DailyTotals } from "./usageMerge.ts";
import {
  buildUsageChartColumns,
  buildUsageChartGeometry,
  niceUsageChartScale,
} from "./usageChart.ts";

const PROVIDERS = ["codex", "claude"] as const;
const DAYS = ["2026-08-01", "2026-08-02", "2026-08-03"];
const DAILY: readonly DailyTotals[] = [
  {
    day: DAYS[0] ?? "",
    costUsd: 55,
    totalTokens: 550,
    byProvider: new Map([
      ["codex", { costUsd: 30, totalTokens: 300 }],
      ["claude", { costUsd: 25, totalTokens: 250 }],
    ]),
  },
  // The middle day is deliberately absent to exercise zero-filled gaps.
  {
    day: DAYS[2] ?? "",
    costUsd: 45,
    totalTokens: 450,
    byProvider: new Map([
      ["codex", { costUsd: 5, totalTokens: 50 }],
      ["claude", { costUsd: 40, totalTokens: 400 }],
    ]),
  },
];

function geometry(metric: "cost" | "tokens" = "cost") {
  return buildUsageChartGeometry({
    days: DAYS,
    daily: DAILY,
    metric,
    providers: PROVIDERS,
    width: 200,
    height: 100,
    plotTop: 0,
    tickCount: 4,
  });
}

describe("niceUsageChartScale", () => {
  it("never puts the peak above the top of the scale", () => {
    for (const peak of [1122.71, 999, 1, 0.04, 1_400_000_000, 37.5, 5000, 100.001]) {
      expect(niceUsageChartScale(peak, 4).max, `peak ${peak}`).toBeGreaterThanOrEqual(peak);
    }
  });

  it("uses evenly spaced 1/2/5 steps from zero", () => {
    const { max, ticks } = niceUsageChartScale(1122.71, 4);
    const steps = ticks.slice(1).map((tick, index) => tick - (ticks[index] ?? 0));

    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBeCloseTo(max, 6);
    for (const step of steps) expect(step).toBeCloseTo(steps[0] ?? 0, 6);
    const first = steps[0] ?? 0;
    const normalized = first / 10 ** Math.floor(Math.log10(first));
    expect([1, 2, 5, 10]).toContain(Math.round(normalized));
  });

  it("degrades to a single zero tick with no data", () => {
    expect(niceUsageChartScale(0, 4)).toEqual({ max: 0, ticks: [0] });
  });
});

describe("buildUsageChartColumns", () => {
  it("keeps provider values absolute and zero-fills missing days", () => {
    const columns = buildUsageChartColumns(DAYS, DAILY, "cost", PROVIDERS);

    expect(columns[0]?.bands).toEqual([
      { provider: "codex", value: 30 },
      { provider: "claude", value: 25 },
    ]);
    expect(columns[1]).toEqual({
      bands: [
        { provider: "codex", value: 0 },
        { provider: "claude", value: 0 },
      ],
      total: 0,
    });
  });

  it("reads token values without making them cumulative", () => {
    expect(buildUsageChartColumns(DAYS, DAILY, "tokens", PROVIDERS)[0]?.bands).toEqual([
      { provider: "codex", value: 300 },
      { provider: "claude", value: 250 },
    ]);
  });

  it("zero-fills inactive hourly periods", () => {
    const hours = [
      "2026-08-11T08:37:00.000Z",
      "2026-08-11T09:37:00.000Z",
      "2026-08-11T10:37:00.000Z",
    ];
    const hourly: readonly DailyTotals[] = [
      {
        day: hours[1] ?? "",
        costUsd: 4,
        totalTokens: 40,
        byProvider: new Map([["codex", { costUsd: 4, totalTokens: 40 }]]),
      },
    ];

    expect(
      buildUsageChartColumns(hours, hourly, "cost", PROVIDERS).map((column) => column.total),
    ).toEqual([0, 4, 0]);
  });
});

describe("buildUsageChartGeometry", () => {
  it("scales to the largest single provider-day instead of the combined total", () => {
    // The provider peak is 40 (scale max 40); combined daily peaks are 55 and 45
    // and would produce a scale max of 60.
    expect(geometry().ticks.at(-1)).toBe(40);
  });

  it("closes every area to the shared zero baseline", () => {
    const fills = geometry().layers.filter((layer) => layer.kind === "fill");

    expect(fills).toHaveLength(2);
    for (const fill of fills) expect(fill.path).toMatch(/ L200,100 L0,100 Z$/);
  });

  it("paints the heavier fill first, then draws every two-pixel stroke", () => {
    const layers = geometry().layers;

    expect(layers.map((layer) => `${layer.kind}:${layer.provider}`)).toEqual([
      "fill:claude",
      "fill:codex",
      "stroke:claude",
      "stroke:codex",
    ]);
    expect(layers.filter((layer) => layer.kind === "fill").map((layer) => layer.opacity)).toEqual([
      0.12, 0.12,
    ]);
    expect(layers.filter((layer) => layer.kind === "stroke").map((layer) => layer.width)).toEqual([
      2, 2,
    ]);
  });

  it("keeps crossing series independent through a missing day", () => {
    const strokes = geometry().layers.filter((layer) => layer.kind === "stroke");
    const codex = strokes.find((layer) => layer.provider === "codex");
    const claude = strokes.find((layer) => layer.provider === "claude");

    expect(codex?.path).toMatch(/^M0\.00,25\.00 C/);
    expect(codex?.path).toMatch(/200\.00,87\.50$/);
    expect(claude?.path).toMatch(/^M0\.00,37\.50 C/);
    expect(claude?.path).toMatch(/200\.00,0\.00$/);
    expect(codex?.path).toContain("100.00,100.00");
    expect(claude?.path).toContain("100.00,100.00");
  });
});
