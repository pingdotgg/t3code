import {
  EnvironmentId,
  UsageDay,
  UsageReadError,
  USAGE_CONTRACT_VERSION,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  dailyFallback,
  distinctLabels,
  environmentsNeedingBaseline,
  isRejectedWindow,
  useUsage,
  type EnvironmentUsageStatus,
  type UsageView,
} from "./usage";

const testState = vi.hoisted(() => ({ environments: [] as EnvironmentUsageStatus[] }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => testState.environments,
}));

const input = {
  sinceDay: UsageDay.make("2026-09-04"),
  untilDay: UsageDay.make("2026-09-04"),
  timeZone: "UTC",
};

function environment(id: string, cost: number | null, hostId = id): EnvironmentUsageStatus {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    isPending: cost === null,
    canReadDiagnostics: true,
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
                provider: "codex",
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
                  provider: "codex",
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

let renderer: ReactTestRenderer | undefined;
let latest: UsageView;

function Probe({ selected }: { selected: ReadonlySet<EnvironmentId> | null }) {
  const usage = useUsage(input, selected);
  useLayoutEffect(() => {
    latest = usage;
  }, [usage]);
  return null;
}

async function select(...ids: string[]) {
  await act(() => {
    renderer?.update(<Probe selected={new Set(ids.map((id) => EnvironmentId.make(id)))} />);
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.environments = [environment("a", 10), environment("b", 20), environment("slow", null)];
  await act(() => {
    renderer = create(<Probe selected={null} />);
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("usage environment selection", () => {
  it("starts with all environments and adds results as they arrive", async () => {
    expect(latest.merged.costUsd).toBe(30);
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(true);

    testState.environments = [...testState.environments.slice(0, 2), environment("slow", 40)];
    await act(() => renderer?.update(<Probe selected={null} />));
    expect(latest.merged.costUsd).toBe(70);
    expect(latest.isPartial).toBe(false);
  });

  it("excludes unselected usage and pending environments, then restores all", async () => {
    await select("b");
    expect(latest.merged.costUsd).toBe(20);
    expect(latest.merged.models.map((model) => model.model)).toEqual(["b"]);
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(false);
    expect(latest.environments).toHaveLength(3);

    await act(() => renderer?.update(<Probe selected={null} />));
    expect(latest.merged.costUsd).toBe(30);
    expect(latest.isPartial).toBe(true);
  });

  it("distinguishes a pending selection from an empty or failed selection", async () => {
    await select("slow");
    expect(latest.isPending).toBe(true);
    expect(latest.merged.costUsd).toBe(0);

    await select();
    expect(latest.selectedEnvironments).toHaveLength(0);
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(false);

    testState.environments = [{ ...environment("slow", null), isPending: false, error: "Offline" }];
    await select("slow");
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(false);
  });

  it("deduplicates within the selection so an excluded owner cannot hide usage", async () => {
    testState.environments = [environment("a", 10, "shared"), environment("b", 20, "shared")];
    await act(() => renderer?.update(<Probe selected={null} />));
    expect(latest.merged.costUsd).toBe(10);

    await select("b");
    expect(latest.merged.costUsd).toBe(20);
    expect(latest.merged.duplicateSources).toEqual([]);
  });

  it("keeps selected cached results visible during a refresh", async () => {
    testState.environments = [
      { ...environment("a", 10), isPending: true },
      environment("slow", null),
    ];
    await select("a");
    expect(latest.merged.costUsd).toBe(10);
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(false);
  });
});

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
