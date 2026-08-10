import type { CursorUsageEvent } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { aggregateCursorUsageBuckets } from "./CursorUsageAggregation.ts";

function event(overrides: Partial<CursorUsageEvent> = {}): CursorUsageEvent {
  return {
    id: "evt_1" as CursorUsageEvent["id"],
    // 2026-08-07T04:05Z is still Aug 6 in Los Angeles.
    occurredAt: "2026-08-07T04:05:13.944Z",
    day: "2026-08-07" as CursorUsageEvent["day"],
    model: "cursor-grok-4.5",
    usageType: "included",
    inputTokens: 100,
    outputTokens: 50,
    cacheWriteTokens: 10,
    cacheReadTokens: 20,
    rawCostCents: 250,
    chargedCents: 0,
    ...overrides,
  };
}

describe("aggregateCursorUsageBuckets", () => {
  it("buckets by day in the requested time zone, not UTC", () => {
    const buckets = aggregateCursorUsageBuckets({
      events: [event()],
      timeZone: "America/Los_Angeles",
    });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.day).toBe("2026-08-06");
  });

  it("sums token totals and cost across events in the same (day, model, usageType) cell", () => {
    const buckets = aggregateCursorUsageBuckets({
      events: [
        event({ id: "evt_1" as CursorUsageEvent["id"] }),
        event({ id: "evt_2" as CursorUsageEvent["id"] }),
      ],
      timeZone: "UTC",
    });
    expect(buckets).toHaveLength(1);
    const bucket = buckets[0];
    expect(bucket?.totals.uncachedInputTokens).toBe(200);
    expect(bucket?.totals.outputTokens).toBe(100);
    expect(bucket?.records).toBe(2);
    expect(bucket?.costUsd).toBeCloseTo(5, 5);
  });

  it("splits included and on-demand usage into separate buckets", () => {
    const buckets = aggregateCursorUsageBuckets({
      events: [
        event({ id: "evt_1" as CursorUsageEvent["id"], usageType: "included" }),
        event({ id: "evt_2" as CursorUsageEvent["id"], usageType: "onDemand" }),
      ],
      timeZone: "UTC",
    });
    expect(buckets).toHaveLength(2);
    expect(buckets.map((bucket) => bucket.usageType).toSorted()).toEqual(["included", "onDemand"]);
  });

  it("marks a bucket unpriced when none of its events carry a cost", () => {
    const buckets = aggregateCursorUsageBuckets({
      events: [event({ rawCostCents: undefined })],
      timeZone: "UTC",
    });
    expect(buckets[0]?.costSource).toBe("unpriced");
    expect(buckets[0]?.unpricedRecords).toBe(1);
    expect(buckets[0]?.costUsd).toBe(0);
  });

  it("separates buckets by model", () => {
    const buckets = aggregateCursorUsageBuckets({
      events: [
        event({ id: "evt_1" as CursorUsageEvent["id"], model: "model-a" }),
        event({ id: "evt_2" as CursorUsageEvent["id"], model: "model-b" }),
      ],
      timeZone: "UTC",
    });
    expect(buckets).toHaveLength(2);
  });

  it("returns nothing for an empty event list", () => {
    expect(aggregateCursorUsageBuckets({ events: [], timeZone: "UTC" })).toEqual([]);
  });
});
