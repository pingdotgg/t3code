import { describe, expect, it } from "vite-plus/test";

import {
  appendPoolSample,
  buildStreak,
  cpuColumns,
  dailyWindow,
  dayKey,
  DAY_MS,
  estimateBurn,
  fitHeroLayout,
  heroWidgetArea,
  HOUR_MS,
  type PoolProvider,
  projectPool,
  recordedSince,
  sampleAt,
  tokensBetween,
} from "./heroWidgets.logic";
import { DETAILS_CARD_CLEARANCE } from "../chatCanvasLayout";

const NOW = new Date(2026, 10, 17, 15, 0);

function days(entries: ReadonlyArray<readonly [number, number]>): Map<string, number> {
  return new Map(
    entries.map(([offset, tokens]) => [
      dayKey(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offset)),
      tokens,
    ]),
  );
}

describe("dailyWindow", () => {
  it("is one day-resolution window ending today", () => {
    const window = dailyWindow(NOW, 30);
    expect(window.resolution).toBe("day");
    expect(window.untilDay).toBe("2026-11-17");
    expect(window.sinceDay).toBe("2026-10-19");
  });
});

describe("fitHeroLayout", () => {
  it("puts the pool on top and machines beside streak when two cards fit across", () => {
    const layout = fitHeroLayout({ width: 1360, height: 900 })!;
    expect(layout.columns).toBe(2);
    expect(layout.lowerRows).toEqual([["machines", "streak"]]);
    expect(layout.height).toBeLessThanOrEqual(900);
    expect(layout.compactHeight).toBeLessThanOrEqual(layout.height);
  });

  it("stacks the lower widgets on narrow panes and drops what does not fit", () => {
    expect(fitHeroLayout({ width: 600, height: 2000 })!.lowerRows).toEqual([
      ["machines"],
      ["streak"],
    ]);
    expect(fitHeroLayout({ width: 600, height: 470 })!.lowerRows).toEqual([["machines"]]);
    expect(fitHeroLayout({ width: 1360, height: 300 })!.lowerRows).toEqual([]);
    expect(fitHeroLayout({ width: 1360, height: 100 })).toBeNull();
  });
});

describe("heroWidgetArea", () => {
  const pane = {
    width: 1014,
    height: 731,
    stackLeft: 147,
    stackWidth: 720,
    stackHeight: 164,
    headlineHeight: 179,
    detailsLeft: null,
  };
  const center = (area: { left: number; width: number }) => area.left + area.width / 2;

  it("shares the composer's center line, even when a details card narrows one side", () => {
    expect(heroWidgetArea(pane)).toEqual({ left: -99, width: 918, height: 332 });
    // The details card floats beside a composer that stays centered in the whole pane.
    const beside = heroWidgetArea({
      ...pane,
      width: 1774,
      stackLeft: 378,
      stackWidth: 1018,
      detailsLeft: 1542,
    });
    expect(center(beside)).toBe(1018 / 2);
    expect(378 + beside.left + beside.width).toBeLessThanOrEqual(1542 - DETAILS_CARD_CLEARANCE);
    // The details card at 730 pulls the composer lane left to 48..698.
    expect(
      heroWidgetArea({ ...pane, stackLeft: 48, stackWidth: 650, detailsLeft: 730 }),
    ).toMatchObject({
      left: 0,
      width: 650,
    });
  });

  it("caps the width", () => {
    expect(heroWidgetArea({ ...pane, width: 2400, stackLeft: 840 }).width).toBe(1360);
  });

  it("leaves the headline what it needs, and at least the minimum", () => {
    expect(heroWidgetArea({ ...pane, headlineHeight: 400 }).height).toBe(111);
    expect(heroWidgetArea({ ...pane, headlineHeight: 0 }).height).toBe(399);
    expect(heroWidgetArea({ ...pane, height: 300 }).height).toBe(0);
  });
});

describe("buildStreak", () => {
  it("counts goal days through yesterday while today is still short", () => {
    const streak = buildStreak(
      NOW,
      days([
        [-5, 2e9],
        [-4, 5e8],
        [-3, 1.2e9],
        [-2, 3e9],
        [-1, 1e9],
        [0, 7.8e8],
      ]),
      1e9,
      10,
    );
    expect(streak.current).toBe(3);
    expect(streak.best).toBe(3);
    expect(streak.todayMet).toBe(false);
    expect(streak.days.filter((day) => day.state === "noData")).toHaveLength(4);
    expect(streak.days.filter((day) => day.state === "missed")).toHaveLength(1);
    expect(streak.bestDay?.tokens).toBe(3e9);
    expect(streak.medianDay).toBe(1.2e9);
  });

  it("extends the streak once today reaches the goal", () => {
    const streak = buildStreak(
      NOW,
      days([
        [-1, 1e9],
        [0, 1.5e9],
      ]),
      1e9,
      5,
    );
    expect(streak.current).toBe(2);
    expect(streak.todayMet).toBe(true);
  });
});

function provider(
  driver: string,
  accounts: ReadonlyArray<{ left: number; resetsInHours: number }>,
): PoolProvider {
  return {
    driver,
    windowLabel: "Weekly",
    accounts: accounts.map((account, index) => ({
      key: `${driver}:${index}`,
      name: `${driver} ${index}`,
      left: account.left,
      resetsAt: NOW.getTime() + account.resetsInHours * HOUR_MS,
      periodMs: 7 * DAY_MS,
    })),
    capacity: accounts.length * 100,
    left: accounts.reduce((sum, account) => sum + account.left, 0),
  };
}

describe("tokensBetween", () => {
  it("spreads each day over its elapsed hours", () => {
    const byDay = days([
      [-1, 24],
      [0, 15],
    ]);
    const now = NOW.getTime();
    // 9 of yesterday's 24 hours, then all 15 elapsed hours of today.
    expect(tokensBetween(byDay, now - 24 * HOUR_MS, now, now)).toBeCloseTo(9 + 15, 5);
    expect(tokensBetween(byDay, now - 12 * HOUR_MS, now, now)).toBeCloseTo(12, 5);
  });
});

describe("estimateBurn", () => {
  it("prices the recent token rate at the percent per token since the window started", () => {
    const pool = provider("claudeAgent", [{ left: 50, resetsInHours: 24 * 5 }]);
    // The window started two days ago; 50 points went on 4 tokens a day, 2 days at 4 tokens.
    const byDay = days([
      [-3, 4],
      [-2, 4],
      [-1, 4],
      [0, 4 * (15 / 24)],
    ]);
    const burn = estimateBurn(pool, byDay, NOW.getTime());
    expect(burn.source).toBe("tokens");
    expect(burn.perHour).toBeGreaterThan(0);
    expect(burn.perHour * 48).toBeCloseTo(50, 0);
  });
});

describe("projectPool", () => {
  it("drains the soonest-resetting account first, marks the dry span, and refills", () => {
    const pool = provider("claudeAgent", [
      { left: 10, resetsInHours: 48 },
      { left: 10, resetsInHours: 72 },
    ]);
    const now = NOW.getTime();
    const projection = projectPool([pool], new Map([["claudeAgent", 1]]), now, now + 4 * DAY_MS);
    const span = projection.dry[0]!;
    expect(span.driver).toBe("claudeAgent");
    expect(span.from).toBeGreaterThan(now + 19 * HOUR_MS);
    expect(span.from).toBeLessThan(now + 21 * HOUR_MS);
    expect(span.to).toBe(now + 48 * HOUR_MS);
    expect(span.duration).toBe(span.to! - span.from);
    expect(projection.refills[0]).toMatchObject({ account: "claudeAgent 0", amount: 100 });
    // The first account drains before the second is touched.
    const first = projection.accountSeries.get("claudeAgent:0")!;
    const second = projection.accountSeries.get("claudeAgent:1")!;
    expect(first[6]).toBeCloseTo(9, 5);
    expect(second[6]).toBe(10);
  });

  it("reports the whole pool dry only while every provider is dry", () => {
    const now = NOW.getTime();
    const claude = provider("claudeAgent", [{ left: 10, resetsInHours: 48 }]);
    const codex = provider("codex", [{ left: 20, resetsInHours: 30 }]);
    const projection = projectPool(
      [claude, codex],
      new Map([
        ["claudeAgent", 1],
        ["codex", 1],
      ]),
      now,
      now + 3 * DAY_MS,
    );
    // Claude is dry from ~10h to 48h, Codex from ~20h to 30h.
    expect(projection.poolDry).toHaveLength(1);
    const span = projection.poolDry[0]!;
    expect(span.from).toBeGreaterThan(now + 19 * HOUR_MS);
    expect(span.from).toBeLessThan(now + 21 * HOUR_MS);
    expect(span.to).toBe(now + 30 * HOUR_MS);
  });

  it("keeps a slow provider out of the whole-pool dry spans", () => {
    const now = NOW.getTime();
    const projection = projectPool(
      [
        provider("claudeAgent", [{ left: 5, resetsInHours: 48 }]),
        provider("codex", [{ left: 99, resetsInHours: 100 }]),
      ],
      new Map([
        ["claudeAgent", 1],
        ["codex", 0.01],
      ]),
      now,
      now + 3 * DAY_MS,
    );
    expect(projection.dry.map((span) => span.driver)).toEqual(["claudeAgent"]);
    expect(projection.poolDry).toEqual([]);
  });
});

describe("pool samples", () => {
  it("records changes, thins repeats, and reads the latest sample within a gap", () => {
    let samples = appendPoolSample([], { t: 0, p: { codex: [90, 100] } });
    samples = appendPoolSample(samples, { t: 60_000, p: { codex: [90, 100] } });
    samples = appendPoolSample(samples, { t: 120_000, p: { codex: [80, 100] } });
    expect(samples).toHaveLength(2);
    expect(sampleAt(samples, 100_000, HOUR_MS)?.p.codex?.[0]).toBe(90);
    expect(sampleAt(samples, 5 * HOUR_MS, HOUR_MS)).toBeNull();
  });

  it("records a change in one account even when the provider total holds", () => {
    let samples = appendPoolSample([], { t: 0, p: { codex: [100, 200] }, a: { x: 50, y: 50 } });
    samples = appendPoolSample(samples, {
      t: 60_000,
      p: { codex: [100, 200] },
      a: { x: 40, y: 60 },
    });
    expect(samples).toHaveLength(2);
  });

  it("finds where the unbroken history ending now starts", () => {
    const now = 100 * HOUR_MS;
    const at = (hoursAgo: number) => ({ t: now - hoursAgo * HOUR_MS, p: {} });
    // Every 2h back to 6h ago, then 6h, 8h and 10h holes.
    const samples = [at(30), at(20), at(12), at(6), at(4), at(2), at(0)];
    expect(recordedSince(samples, now, 3 * HOUR_MS, 24 * HOUR_MS)).toBe(now - 6 * HOUR_MS);
    expect(recordedSince(samples, now, 12 * HOUR_MS, 24 * HOUR_MS)).toBe(now - 24 * HOUR_MS);
    expect(recordedSince([at(5)], now, 3 * HOUR_MS, 24 * HOUR_MS)).toBe(now);
    expect(recordedSince([], now, 3 * HOUR_MS, 24 * HOUR_MS)).toBe(now);
  });
});

describe("cpuColumns", () => {
  // Four 15-minute columns across the hour ending at `now`.
  const now = NOW.getTime();
  const at = (minutesAgo: number, cpu: number | null) => ({ t: now - minutesAgo * 60_000, cpu });

  it("keeps the busiest reading in a column and shows gaps where readings stop", () => {
    const samples = [at(70, 1), at(50, 0.2), at(48, 0.9), at(47, 0.3), at(10, 0.4)];

    // 70 min ago is outside the hour; nothing between 47 and 10 min ago fills columns 2 and 3.
    expect(cpuColumns(samples, now, 4)).toEqual([0.9, null, null, 0.4]);
  });

  it("carries a fresh reading into a column it did not reach", () => {
    expect(cpuColumns([at(30.25, 0.5)], now, 120)[60]).toBe(0.5);
    expect(cpuColumns([at(30.25, 0.5)], now, 120)[62]).toBeNull();
  });
});
