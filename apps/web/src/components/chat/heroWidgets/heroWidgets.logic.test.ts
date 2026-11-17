import { describe, expect, it } from "vite-plus/test";

import {
  appendPoolSample,
  buildStreak,
  dailyWindow,
  dayKey,
  DAY_MS,
  estimateBurn,
  fitHeroLayout,
  HOUR_MS,
  type PoolProvider,
  projectPool,
  sampleAt,
  tokensBetween,
} from "./heroWidgets.logic";

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
  it("drains the soonest-resetting account first, marks the empty band, and refills", () => {
    const pool = provider("claudeAgent", [
      { left: 10, resetsInHours: 48 },
      { left: 10, resetsInHours: 72 },
    ]);
    const now = NOW.getTime();
    const projection = projectPool([pool], new Map([["claudeAgent", 1]]), now, now + 4 * DAY_MS);
    const band = projection.bands[0]!;
    expect(band.from).toBeGreaterThan(now + 19 * HOUR_MS);
    expect(band.from).toBeLessThan(now + 21 * HOUR_MS);
    expect(band.to).toBe(now + 48 * HOUR_MS);
    expect(projection.refills[0]).toMatchObject({ account: "claudeAgent 0", amount: 100 });
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
});
