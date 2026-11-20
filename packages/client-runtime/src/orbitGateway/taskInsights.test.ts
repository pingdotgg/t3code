import { describe, expect, it } from "vite-plus/test";

import type { OrbitTaskInsights, OrbitTaskInsightsSummary } from "./tasks.ts";
import { INSIGHTS, insightChangeTone, insightResults, insightTrend } from "./taskInsights.ts";

const EMPTY: OrbitTaskInsightsSummary = {
  tasks: null,
  merged: null,
  tokens: null,
  tokensPerMergedPr: null,
  leadTimeMs: null,
  deliveryTimeMs: null,
  deployWaitMs: null,
  prMergeWaitMs: null,
  prFirstPass: null,
  wastedShare: null,
  reviewRounds: null,
};

function insights(overrides: Partial<OrbitTaskInsights> = {}): OrbitTaskInsights {
  return {
    period: "30d",
    current: {
      ...EMPTY,
      merged: 22,
      tokens: 900,
      leadTimeMs: 100,
      prFirstPass: 0.58,
      wastedShare: 0.18,
      reviewRounds: 1.6,
    },
    previous: {
      ...EMPTY,
      merged: 20,
      tokens: 1000,
      leadTimeMs: 200,
      prFirstPass: 0.61,
      wastedShare: 0.16,
      reviewRounds: 1.8,
    },
    weekly: [],
    daily: [],
    hourly: [],
    byModel: [],
    ...overrides,
  };
}

const spec = (id: string) => INSIGHTS.find((entry) => entry.id === id)!;

describe("task insights", () => {
  it("shows dashes for a failed read and for numbers Orbit does not report yet", () => {
    for (const result of Object.values(insightResults(null))) {
      expect(result).toEqual({ value: null, change: null });
    }
    const results = insightResults(insights());
    // Orbit 6042: Orbit's own merge wait starts at settled subtasks, so it is not used.
    expect(results.mergeWait).toEqual({ value: null, change: null });
    expect(results.tokens).toEqual({ value: null, change: null });
  });

  it("compares amounts in percent, shares in points and review rounds as a difference", () => {
    const results = insightResults(insights());
    expect(results.completed).toEqual({ value: 22, change: 10 });
    expect(results.spent).toEqual({ value: 900, change: -10 });
    expect(results.wasted).toEqual({ value: 0.18, change: 2 });
    expect(results.firstPass).toEqual({ value: 0.58, change: -3 });
    expect(results.reviewRounds).toEqual({ value: 1.6, change: -0.2 });
  });

  it("runs delivery time to deployed once Orbit reports it, else to merged", () => {
    expect(insightResults(insights()).delivery).toEqual({ value: 100, change: -50 });
    const deployed = insights();
    const withDeploys = insights({
      current: { ...deployed.current, deliveryTimeMs: 300 },
      previous: { ...deployed.previous, deliveryTimeMs: 400 },
    });
    expect(insightResults(withDeploys).delivery).toEqual({ value: 300, change: -25 });
  });

  it("colours a change by which way is good, and never colours tokens spent", () => {
    expect(insightChangeTone(spec("completed"), 10)).toBe("good");
    expect(insightChangeTone(spec("delivery"), 10)).toBe("bad");
    expect(insightChangeTone(spec("delivery"), -10)).toBe("good");
    expect(insightChangeTone(spec("spent"), 40)).toBe("neutral");
    expect(insightChangeTone(spec("completed"), 0)).toBe("neutral");
    expect(insightChangeTone(spec("completed"), null)).toBe("neutral");
  });

  it("charts merges over a trailing window and tokens per task by week without bucket values", () => {
    const daily = Array.from({ length: 7 }, (_, index) => ({
      date: `2026-11-1${index}`,
      merged: index,
      values: EMPTY,
    }));
    const week = insights({ period: "7d", daily });
    expect(insightTrend(week, "completed")).toEqual([
      { date: "2026-11-10", value: 0 },
      { date: "2026-11-11", value: 1 },
      { date: "2026-11-12", value: 3 },
      { date: "2026-11-13", value: 6 },
      { date: "2026-11-14", value: 9 },
      { date: "2026-11-15", value: 12 },
      { date: "2026-11-16", value: 15 },
    ]);
    const weekly = [
      { weekStart: "2026-11-02", tokensPerMergedPr: 5 },
      { weekStart: "2026-11-09", tokensPerMergedPr: null },
    ];
    expect(insightTrend(insights({ period: "7d", daily, weekly }), "tokens")).toEqual([
      { date: "2026-11-02", value: 5 },
      { date: "2026-11-09", value: 0 },
    ]);
    // A number no bucket reports is a flat line at 0, not a missing chart.
    expect(insightTrend(week, "wasted")).toEqual(daily.map(({ date }) => ({ date, value: 0 })));
    const hourly = Array.from({ length: 24 }, (_, index) => ({
      hour: `2026-11-19T${String(index).padStart(2, "0")}:00:00+00:00`,
      merged: index < 20 ? 0 : index - 20,
      values: EMPTY,
    }));
    expect(insightTrend(insights({ period: "24h", hourly }), "completed")?.slice(-4)).toEqual([
      { date: "2026-11-19T20:00:00+00:00", value: 0 },
      { date: "2026-11-19T21:00:00+00:00", value: 1 },
      { date: "2026-11-19T22:00:00+00:00", value: 3 },
      { date: "2026-11-19T23:00:00+00:00", value: 6 },
    ]);
    // An older Orbit answers the 24-hour period without hours: no line, not a daily one.
    expect(insightTrend(insights({ period: "24h", daily }), "completed")).toBeNull();
    expect(insightTrend(null, "completed")).toBeNull();
  });

  it("charts every other number per day or per hour as one line, 0 where a bucket has none", () => {
    // Orbit left out 2026-11-15 and 2026-11-16, and the period starts on 2026-11-13.
    const daily = [
      {
        date: "2026-11-14",
        merged: 2,
        values: { ...EMPTY, merged: 2, leadTimeMs: 600, deliveryTimeMs: 900 },
      },
      { date: "2026-11-17", merged: 0, values: { ...EMPTY, merged: 0 } },
      { date: "2026-11-18", merged: 0, values: { ...EMPTY, merged: 0 } },
      {
        date: "2026-11-19",
        merged: 1,
        values: { ...EMPTY, merged: 1, leadTimeMs: 300, reviewRounds: 2 },
      },
    ];
    const week = insights({ period: "7d", daily });
    // Delivery time runs to deployed where a day has it, else to merged, as the tile does.
    expect(insightTrend(week, "delivery")).toEqual([
      { date: "2026-11-13", value: 0 },
      { date: "2026-11-14", value: 900 },
      { date: "2026-11-15", value: 0 },
      { date: "2026-11-16", value: 0 },
      { date: "2026-11-17", value: 0 },
      { date: "2026-11-18", value: 0 },
      { date: "2026-11-19", value: 300 },
    ]);
    expect(insightTrend(week, "completed")).toHaveLength(7);
    // The headline number stays unreported; only the line reads 0.
    expect(insightResults(week).mergeWait).toEqual({ value: null, change: null });
    const hourly = [
      {
        hour: "2026-11-19T10:00:00+00:00",
        merged: 1,
        values: { ...EMPTY, merged: 1, tokens: 400 },
      },
      {
        hour: "2026-11-19T12:00:00+00:00",
        merged: 1,
        values: { ...EMPTY, merged: 1, tokens: 600 },
      },
    ];
    const day = insightTrend(insights({ period: "24h", hourly }), "spent");
    expect(day).toHaveLength(24);
    expect(day?.[0]).toEqual({ date: "2026-11-18T13:00:00+00:00", value: 0 });
    expect(day?.slice(-3)).toEqual([
      { date: "2026-11-19T10:00:00+00:00", value: 400 },
      { date: "2026-11-19T11:00:00+00:00", value: 0 },
      { date: "2026-11-19T12:00:00+00:00", value: 600 },
    ]);
  });
});
