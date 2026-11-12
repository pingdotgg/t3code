import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { LimitPoolWindow } from "./usageLimits.ts";
import { poolBurn, projectionHorizon, projectPool, recordedPool } from "./usagePoolProjection.ts";

const HOUR = 3_600_000;
const now = Date.parse("2026-11-12T12:00:00.000Z");
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));

function pool(
  members: ReadonlyArray<{ key: string; used: number; resetsIn?: number; mins?: number }>,
  kind: LimitPoolWindow["kind"] = "weekly",
): LimitPoolWindow {
  const list = members.map((m) => ({
    account: { key: m.key } as LimitPoolWindow["members"][number]["account"],
    window: {
      id: "seven_day",
      kind,
      label: "Weekly",
      usedPercent: m.used,
      ...(m.resetsIn === undefined ? {} : { resetsAt: iso(now + m.resetsIn) }),
      windowDurationMins: m.mins ?? 7 * 24 * 60,
    },
    refillPercent: m.used,
  }));
  return {
    id: "seven_day",
    kind,
    label: "Weekly",
    members: list,
    columns: list,
    remainingPercent: 0,
    usedPercent: 0,
    pace: null,
    resets: [],
  };
}

describe("projectPool", () => {
  it("sums every account into one pool", () => {
    const projection = projectPool(
      pool([
        { key: "a", used: 60, resetsIn: 48 * HOUR },
        { key: "b", used: 30, resetsIn: 120 * HOUR },
      ]),
      now,
      { burnPerHour: 0, horizonMs: 7 * 24 * HOUR },
    );
    expect(projection.capacity).toBe(200);
    expect(projection.remaining).toBe(110);
    expect(projection.poolEmpty).toBeNull();
    // With no spend, each reset gives back what that account had used.
    expect(projection.refills.map((r) => [r.accountKey, r.restores, r.remainingAfter])).toEqual([
      ["a", 60, 170],
      ["b", 30, 200],
    ]);
    expect(projection.points.at(-1)?.remaining).toBe(200);
  });

  it("spends the account that resets first and finds when the pool runs dry", () => {
    const projection = projectPool(
      pool([
        { key: "late", used: 0, resetsIn: 150 * HOUR },
        { key: "soon", used: 50, resetsIn: 140 * HOUR },
      ]),
      now,
      { burnPerHour: 10, horizonMs: 24 * HOUR, steps: 240 },
    );
    // 50 points left on "soon" at 10/h: empty after 5 h; then 100 on "late": pool dry at 15 h.
    expect(projection.firstEmpty).toEqual({ at: now + 5 * HOUR, accountKey: "soon" });
    expect(projection.poolEmpty).toBe(now + 15 * HOUR);
  });

  it("reports an exhausted account as empty now", () => {
    const projection = projectPool(
      pool([
        { key: "a", used: 100, resetsIn: HOUR },
        { key: "b", used: 0, resetsIn: 5 * HOUR },
      ]),
      now,
      { burnPerHour: 0, horizonMs: 24 * HOUR },
    );
    expect(projection.firstEmpty).toEqual({ at: now, accountKey: "a" });
    expect(projection.poolEmpty).toBeNull();
  });
});

describe("poolBurn", () => {
  const twoAccounts = pool([
    { key: "a", used: 35, resetsIn: 100 * HOUR },
    { key: "b", used: 5, resetsIn: 100 * HOUR },
  ]);

  it("measures spend from stored readings and counts a drop as a reset", () => {
    const burn = poolBurn(
      twoAccounts,
      [
        { at: now - 2 * HOUR, used: { a: 10, b: 90 } },
        { at: now - HOUR, used: { a: 20, b: 100 } },
        { at: now, used: { a: 35, b: 5 } },
      ],
      now,
      3 * HOUR,
    );
    // a: +10 +15, b: +10 then a reset worth 5 → 40 points over 2 h.
    expect(burn).toEqual({ perHour: 20, source: "measured" });
  });

  it("falls back to the average since each window opened", () => {
    // Weekly windows with 100 h left have run 68 h: 35/68 + 5/68 points per hour.
    const burn = poolBurn(twoAccounts, [{ at: now, used: { a: 35, b: 5 } }], now, 3 * HOUR);
    expect(burn.source).toBe("window");
    expect(burn.perHour).toBeCloseTo(40 / 68, 6);
  });
});

describe("recordedPool", () => {
  it("carries an account's last reading forward", () => {
    const series = recordedPool(
      pool([
        { key: "a", used: 0 },
        { key: "b", used: 0 },
      ]),
      [
        { at: now - 3 * HOUR, used: { a: 10 } },
        { at: now - 2 * HOUR, used: { a: 20, b: 50 } },
        { at: now - HOUR, used: { b: 60 } },
      ],
      now - 24 * HOUR,
    );
    expect(series).toEqual([
      { at: now - 2 * HOUR, remaining: 130 },
      { at: now - HOUR, remaining: 120 },
    ]);
  });
});

describe("projectionHorizon", () => {
  it("looks a day ahead for session windows and a week for weekly ones", () => {
    expect(projectionHorizon(pool([{ key: "a", used: 0, mins: 300 }], "session"))).toBe(24 * HOUR);
    expect(projectionHorizon(pool([{ key: "a", used: 0 }]))).toBe(7 * 24 * HOUR);
  });
});
