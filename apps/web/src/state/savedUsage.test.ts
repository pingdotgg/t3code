import {
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageBucket,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pickSavedUsage, type SavedUsage } from "./savedUsage";

const bucket = (day: string, hourStart?: string): UsageBucket => ({
  day: UsageDay.make(day),
  ...(hourStart === undefined ? {} : { hourStart }),
  provider: "claude",
  model: "claude-opus-5-5",
  totals: {
    uncachedInputTokens: 1,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  },
  costUsd: 1,
  cacheSavingsUsd: 0,
  costSource: "modelPriced",
  records: 1,
  unpricedRecords: 0,
  sessions: 1,
});

const summary = (buckets: readonly UsageBucket[], readAt: string): UsageSummary => ({
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt,
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-09-01"),
  untilDay: UsageDay.make("2026-09-30"),
  buckets,
  sources: [],
  pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 1,
});

const days = (sinceDay: string, untilDay: string): UsageSummaryInput => ({
  sinceDay: UsageDay.make(sinceDay),
  untilDay: UsageDay.make(untilDay),
  timeZone: "UTC",
  resolution: "day",
});

const hours = (sinceDay: string, untilDay: string): UsageSummaryInput => ({
  ...days(sinceDay, untilDay),
  resolution: "hour",
  sinceTime: `${sinceDay}T00:00:00.000Z`,
  untilTime: `${untilDay}T12:00:00.000Z`,
});

const month: SavedUsage = {
  input: days("2026-09-01", "2026-09-30"),
  summary: summary(
    [bucket("2026-09-01"), bucket("2026-09-24"), bucket("2026-09-30")],
    "2026-09-30T10:00:00Z",
  ),
};
const week: SavedUsage = {
  input: hours("2026-09-24", "2026-09-30"),
  summary: summary(
    [
      bucket("2026-09-23", "2026-09-23T23:00:00.000Z"),
      bucket("2026-09-24", "2026-09-24T09:00:00.000Z"),
      bucket("2026-09-30", "2026-09-30T13:00:00.000Z"),
    ],
    "2026-09-30T14:00:00Z",
  ),
};

describe("pickSavedUsage", () => {
  it("cuts the saved read that covers most of the range to that range", () => {
    const picked = pickSavedUsage([week, month], days("2026-09-20", "2026-09-30"));
    expect(picked?.readByDay).toBe(false);
    expect(picked?.summary.buckets.map((entry) => entry.day)).toEqual(["2026-09-24", "2026-09-30"]);
    // The read time stays, so the page can say when the usage is from.
    expect(picked?.summary.readAt).toBe("2026-09-30T10:00:00Z");
  });

  it("prefers a saved read at the same resolution, and cuts hours to the window", () => {
    const picked = pickSavedUsage([month, week], hours("2026-09-24", "2026-09-30"));
    expect(picked?.readByDay).toBe(false);
    expect(picked?.summary.buckets.map((entry) => entry.hourStart)).toEqual([
      "2026-09-24T09:00:00.000Z",
    ]);
  });

  it("answers an hourly range by day when only a daily read is saved", () => {
    const picked = pickSavedUsage([month], hours("2026-09-24", "2026-09-30"));
    expect(picked?.readByDay).toBe(true);
    expect(picked?.summary.buckets).toHaveLength(2);
  });

  it("finds nothing outside the saved days or in another time zone", () => {
    expect(pickSavedUsage([month], days("2026-10-01", "2026-10-07"))).toBeNull();
    expect(
      pickSavedUsage([month], { ...days("2026-09-01", "2026-09-30"), timeZone: "Asia/Tokyo" }),
    ).toBeNull();
  });
});
