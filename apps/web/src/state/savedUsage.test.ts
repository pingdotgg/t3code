import {
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageBucket,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pickSavedUsage, type SavedUsage, withoutLiveSources } from "./savedUsage";

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

const source = (homePath: string) => ({
  fingerprint: {
    hostId: "mac",
    provider: "claude" as const,
    resolvedHomePath: homePath,
    volumeId: "v",
  },
  status: "ok" as const,
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 1,
  message: null,
});

const summary = (buckets: readonly UsageBucket[], readAt: string): UsageSummary => ({
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt,
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-09-01"),
  untilDay: UsageDay.make("2026-09-30"),
  buckets,
  sources: [source("/home/a/.claude")],
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
    expect(picked?.buckets.map((entry) => entry.day)).toEqual(["2026-09-24", "2026-09-30"]);
    // The read time stays, so the page can say when the usage is from.
    expect(picked?.readAt).toBe("2026-09-30T10:00:00Z");
    expect(picked?.sources[0]?.status).toBe("ok");
  });

  it("marks a read that covers only part of the range as partial", () => {
    const picked = pickSavedUsage([month], days("2026-09-20", "2026-10-05"));
    expect(picked?.buckets.map((entry) => entry.day)).toEqual(["2026-09-24", "2026-09-30"]);
    expect(picked?.sources[0]?.status).toBe("partial");
  });

  it("answers hours only with hours on the same hour grid", () => {
    const sameGrid = pickSavedUsage([month, week], hours("2026-09-24", "2026-09-30"));
    expect(sameGrid?.buckets.map((entry) => entry.hourStart)).toEqual(["2026-09-24T09:00:00.000Z"]);
    // A daily read cannot be split into hours, nor a read on another grid.
    expect(pickSavedUsage([month], hours("2026-09-24", "2026-09-30"))).toBeNull();
    const shifted = { ...hours("2026-09-24", "2026-09-30"), sinceTime: "2026-09-24T00:30:00.000Z" };
    expect(pickSavedUsage([week], shifted)).toBeNull();
  });

  it("finds nothing outside the saved days or in another time zone", () => {
    expect(pickSavedUsage([month], days("2026-10-01", "2026-10-07"))).toBeNull();
    expect(
      pickSavedUsage([month], { ...days("2026-09-01", "2026-09-30"), timeZone: "Asia/Tokyo" }),
    ).toBeNull();
  });
});

describe("withoutLiveSources", () => {
  it("drops the history folders a live environment also reads", () => {
    const saved = {
      ...summary(
        [
          { ...bucket("2026-09-24"), sourcePath: "/home/a/.claude" },
          { ...bucket("2026-09-24"), sourcePath: "/home/b/.claude" },
        ],
        "2026-09-30T10:00:00Z",
      ),
      sources: [source("/home/a/.claude"), source("/home/b/.claude")],
    };
    const live = { ...summary([], "2026-10-01T10:00:00Z"), sources: [source("/home/a/.claude")] };
    const kept = withoutLiveSources(saved, [live]);
    expect(kept.sources.map((entry) => entry.fingerprint.resolvedHomePath)).toEqual([
      "/home/b/.claude",
    ]);
    expect(kept.buckets.map((entry) => entry.sourcePath)).toEqual(["/home/b/.claude"]);
    expect(withoutLiveSources(saved, [])).toBe(saved);
  });
});
