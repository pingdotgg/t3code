import type { LineChartSpec } from "./lineChart.ts";

/**
 * Backfill scaling, measured on Cloudflare by
 * `packages/integration-tests/test/Cloudflare/Domain/CatchUp.scale.test.ts`
 * (2026-10-31): accounts with 10 deposits each, then a deploy that rebuilds a
 * view per account. "Before" is the first design, where each account routed
 * its own history (`CatchUp.bench.test.ts`, 2026-10-29).
 */
export const backfillCharts = {
  timeByWidth: {
    title: "How long the deploy waits, by number of accounts",
    x: { label: "Accounts, 10 deposits each", ticks: [10_000, 100_000, 1_000_000], log: true },
    y: { label: "Seconds", ticks: [0, 300, 600, 900, 1200] },
    unit: "s",
    series: [
      {
        name: "Before: accounts route their own history",
        points: [
          [10_000, 353],
          [100_000, 1048],
        ],
      },
      {
        name: "A run over the directory",
        points: [
          [10_000, 13],
          [100_000, 58],
          [1_000_000, 481],
        ],
      },
    ],
  },
} satisfies Record<string, LineChartSpec>;

export type BackfillChart = keyof typeof backfillCharts;
