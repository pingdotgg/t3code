import { describe, expect, it } from "vite-plus/test";

import { compareCreatedOrder, nextLocalMessageSequence } from "./chronology.ts";

describe("persisted chronology", () => {
  it("anchors local messages after all known durable sources without inventing legacy keys", () => {
    expect(nextLocalMessageSequence({ messages: [{}], activities: [] })).toBeUndefined();
    expect(
      nextLocalMessageSequence({
        messages: [{ createdSequence: 2 }],
        activities: [{ createdSequence: 5 }],
        proposedPlans: [{ createdSequence: 9 }],
      }),
    ).toBe(10);
  });
  it("keeps event order across a backward clock correction", () => {
    const before = { id: "before", createdAt: "2026-09-05T04:18:50.462Z", createdSequence: 272 };
    const after = { id: "after", createdAt: "2026-09-04T17:18:56.456Z", createdSequence: 273 };

    expect([after, before].sort(compareCreatedOrder)).toEqual([before, after]);
  });

  it("keeps legacy snapshots ordered before new events without comparison cycles", () => {
    const legacy = { id: "legacy", createdAt: "2026-09-05T04:00:00.000Z" };
    const earlier = { id: "earlier", createdAt: "2026-09-05T03:00:00.000Z" };
    const current = { id: "current", createdAt: "2026-09-04T17:00:00.000Z", createdSequence: 273 };

    for (const entries of [
      [current, legacy, earlier],
      [earlier, current, legacy],
      [legacy, earlier, current],
    ]) {
      expect(entries.sort(compareCreatedOrder)).toEqual([earlier, legacy, current]);
    }
  });

  it("uses stable ids for equal timestamps in legacy history", () => {
    const first = { id: "a", createdAt: "2026-09-04T17:00:00.000Z" };
    const second = { ...first, id: "b" };

    expect([second, first].sort(compareCreatedOrder)).toEqual([first, second]);
  });
});
