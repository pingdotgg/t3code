import {
  EnvironmentId,
  UsageDay,
  UsageReadError,
  USAGE_CONTRACT_VERSION,
  type UsageProviderKind,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import {
  dailyFallback,
  baselineCoversCurrent,
  distinctLabels,
  environmentsNeedingBaseline,
  isRejectedWindow,
  type EnvironmentUsageStatus,
} from "./usage";
const input = {
  sinceDay: UsageDay.make("2026-09-04"),
  untilDay: UsageDay.make("2026-09-04"),
  timeZone: "UTC",
};

function environment(
  id: string,
  cost: number | null,
  hostId = id,
  provider: UsageProviderKind = "codex",
): EnvironmentUsageStatus {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    isPending: cost === null,
    canReadDiagnostics: true,
    isConnected: true,
    error: null,
    needsCursorKeychainAccess: false,
    readByDay: false,
    offline: false,
    savedAt: null,
    window: input,
    summary:
      cost === null
        ? null
        : {
            ...input,
            contractVersion: USAGE_CONTRACT_VERSION,
            readAt: "2026-09-04T12:00:00Z",
            buckets: [
              {
                day: input.sinceDay,
                provider,
                model: id,
                totals: {
                  uncachedInputTokens: 100,
                  cachedInputTokens: 0,
                  cacheCreationTokens: 0,
                  outputTokens: 50,
                  reasoningTokens: 0,
                },
                costUsd: cost,
                cacheSavingsUsd: 0,
                costSource: "modelPriced",
                records: 1,
                unpricedRecords: 0,
                sessions: 1,
              },
            ],
            sources: [
              {
                fingerprint: {
                  hostId,
                  provider,
                  resolvedHomePath: "/sessions",
                  volumeId: hostId,
                },
                status: "ok",
                scannedFiles: 1,
                skippedFiles: 0,
                malformedRecords: 0,
                distinctSessions: 1,
                message: null,
              },
            ],
            pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
            scanDurationMs: 1,
          },
  };
}

describe("environmentsNeedingBaseline", () => {
  it("needs every answering environment, except an offline one counted elsewhere", () => {
    const live = environment("live", 10);
    // Saved usage of its own, but none in this span.
    const base = environment("quiet", 0);
    const quiet = {
      ...base,
      summary: base.summary === null ? null : { ...base.summary, buckets: [] },
      offline: true,
      savedAt: "2026-09-04T11:00:00Z",
    };
    // Reads the same folder as "live": its saved usage is counted from there.
    const copy = {
      ...environment("copy", 10, "live"),
      offline: true,
      savedAt: "2026-09-04T11:00:00Z",
    };
    expect(environmentsNeedingBaseline([live, quiet, copy, environment("pending", null)])).toEqual([
      "live",
      "quiet",
    ]);
  });
});

describe("distinctLabels", () => {
  it("adds where each runs only to names environments share", () => {
    const entry = (label: string, place: string) => ({ label, place: () => place });
    expect(
      distinctLabels([
        entry("Studio", "127.0.0.1:3773"),
        entry("Studio", "127.0.0.1:4000"),
        entry("Laptop", "laptop.tail:3773"),
      ]),
    ).toEqual(["Studio · 127.0.0.1:3773", "Studio · 127.0.0.1:4000", "Laptop"]);
  });
});

describe("dailyFallback", () => {
  it("reads a week-long hourly window by day for servers that reject it", () => {
    const week = {
      sinceDay: UsageDay.make("2026-09-29"),
      untilDay: UsageDay.make("2026-10-05"),
      timeZone: "UTC",
      resolution: "hour" as const,
      sinceTime: "2026-09-29T00:00:00.000Z",
      untilTime: "2026-10-05T12:00:00.000Z",
      groupByThread: true,
    };
    expect(dailyFallback(week)).toEqual({
      sinceDay: week.sinceDay,
      untilDay: week.untilDay,
      timeZone: "UTC",
      resolution: "day",
      groupByThread: true,
    });
    // Every server reads a day by hour, so there is nothing to fall back to.
    expect(dailyFallback({ ...week, sinceTime: "2026-10-04T12:00:00.000Z" })).toBeNull();
    expect(dailyFallback({ ...week, resolution: "day" })).toBeNull();
  });
});

describe("isRejectedWindow", () => {
  it("falls back only when the server rejects the window itself", () => {
    const rejected = new UsageReadError({ reason: "invalidWindow", detail: "at most 24 hours" });
    const failedScan = new UsageReadError({ reason: "scanFailed", detail: "disk error" });
    expect(isRejectedWindow(AsyncResult.failure(Cause.fail(rejected)))).toBe(true);
    // A scan failure or a dropped connection stays an error, not a quieter daily read.
    expect(isRejectedWindow(AsyncResult.failure(Cause.fail(failedScan)))).toBe(false);
    expect(isRejectedWindow(AsyncResult.failure(Cause.die(new Error("socket closed"))))).toBe(
      false,
    );
    expect(isRejectedWindow(AsyncResult.success(1))).toBe(false);
  });
});

describe("baselineCoversCurrent", () => {
  it("holds a comparison while a cached baseline source refreshes, even after another source answered", () => {
    const current = [environment("fast", 2), environment("slow", 4)];
    const fast = environment("fast", 1);
    const slow = { ...environment("slow", 2), isPending: true };
    expect(baselineCoversCurrent(current, [fast, slow])).toBe(false);
    expect(baselineCoversCurrent(current, [fast, { ...slow, isPending: false }])).toBe(true);
  });
  it("requires an answer for each current source, including zero-usage sources", () => {
    const current = [environment("fast", 2), environment("quiet", 0)];
    expect(baselineCoversCurrent(current, [environment("fast", 1)])).toBe(false);
    expect(baselineCoversCurrent(current, [environment("fast", 1), environment("quiet", 0)])).toBe(
      true,
    );
  });
  it("rejects errored baseline cache and waits for a previous-only contributor", () => {
    const current = [environment("fast", 2)];
    expect(baselineCoversCurrent(current, [{ ...environment("fast", 1), error: "offline" }])).toBe(
      false,
    );
    expect(
      baselineCoversCurrent(current, [
        environment("fast", 1),
        { ...environment("older", 3), isPending: true },
      ]),
    ).toBe(false);
  });
});
