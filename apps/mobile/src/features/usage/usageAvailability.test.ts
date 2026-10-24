import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  USAGE_MERGE_COMPATIBLE_SINCE,
  UsageDay,
  type UsageSummary,
} from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { usageAvailability } from "./usageAvailability";

const summary: UsageSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  sinceDay: UsageDay.make("2026-09-05"),
  untilDay: UsageDay.make("2026-09-05"),
  timeZone: "UTC",
  readAt: "2026-09-05T12:00:00Z",
  buckets: [
    {
      day: UsageDay.make("2026-09-05"),
      provider: "claude",
      model: "claude-fable-5",
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 50,
        reasoningTokens: 0,
      },
      costUsd: 10,
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
        hostId: "mac",
        provider: "claude",
        resolvedHomePath: "/home/test/.claude",
        volumeId: "mac-volume",
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
};
const mac = { environmentId: EnvironmentId.make("mac"), label: "MacBook Pro", summary };
const newer = {
  environmentId: EnvironmentId.make("newer"),
  label: "New server",
  summary: { ...summary, contractVersion: USAGE_CONTRACT_VERSION + 1 },
};

function usage(
  environments: readonly (Omit<typeof mac, "summary"> & {
    summary: UsageSummary | null;
    error?: string | null;
    isConnected?: boolean;
    canReadDiagnostics?: boolean;
  })[],
) {
  const merged = mergeUsage(
    environments.flatMap((environment) =>
      environment.summary === null ? [] : [{ ...environment, summary: environment.summary }],
    ),
    USAGE_CONTRACT_VERSION,
  );
  return { merged, availability: usageAvailability(environments, merged.contractMismatches) };
}

describe("usage availability after merging selected environments", () => {
  it("withholds incompatible totals and identifies which side needs updating", () => {
    const older = {
      ...mac,
      summary: { ...summary, contractVersion: USAGE_MERGE_COMPATIBLE_SINCE - 1 },
    };
    const { merged, availability } = usage([older, newer]);
    expect(merged.costUsd).toBe(0);
    expect(availability.hasCompatibleSummary).toBe(false);
    expect(availability.notices).toEqual([
      {
        environmentId: mac.environmentId,
        message: expect.stringContaining("Update the T3 Code server on MacBook Pro"),
      },
      {
        environmentId: newer.environmentId,
        message: expect.stringContaining("Update this app to see usage from New server"),
      },
    ]);
    expect(availability.canRetry).toBe(false);

    const recovered = usage([mac]);
    expect(recovered.merged.costUsd).toBe(10);
    expect(recovered.availability.hasCompatibleSummary).toBe(true);
    expect(recovered.availability.notices).toEqual([]);
  });

  it("distinguishes a failed request from a healthy empty summary without guessing an update", () => {
    const failed = usage([{ ...mac, summary: null, error: "Request failed" }]);
    expect(failed.merged.costUsd).toBe(0);
    expect(failed.availability.hasCompatibleSummary).toBe(false);
    expect(failed.availability.isLoading).toBe(false);
    expect(failed.availability.canRetry).toBe(true);
    expect(failed.availability.notices).toEqual([
      {
        environmentId: mac.environmentId,
        message: "Could not load usage from MacBook Pro. Try again.",
      },
    ]);

    const empty = usage([{ ...mac, summary: { ...summary, buckets: [], sources: [] } }]);
    expect(empty.merged.costUsd).toBe(0);
    expect(empty.merged.totalTokens).toBe(0);
    expect(empty.availability.hasCompatibleSummary).toBe(true);
    expect(empty.availability.isLoading).toBe(false);
    expect(empty.availability.notices).toEqual([]);
    expect(empty.availability.canRetry).toBe(false);
  });

  it("keeps healthy totals while naming incompatible, failed, loading and disconnected omissions", () => {
    const environments = [
      mac,
      newer,
      {
        environmentId: EnvironmentId.make("failed"),
        label: "Failed server",
        summary: null,
        error: "Request failed",
        isConnected: true,
        canReadDiagnostics: true,
      },
      {
        environmentId: EnvironmentId.make("loading"),
        label: "Loading server",
        summary: null,
        isConnected: true,
        error: null,
        canReadDiagnostics: false,
      },
      {
        environmentId: EnvironmentId.make("offline"),
        label: "Offline server",
        summary: null,
        isConnected: false,
      },
    ];
    const { merged, availability } = usage(environments);
    expect(merged.costUsd).toBe(10);
    expect(merged.totalTokens).toBe(150);
    expect(availability.hasCompatibleSummary).toBe(true);
    expect(availability.coverageMessage).toContain("exclude unavailable environments");
    expect(availability.notices).toEqual([
      {
        environmentId: newer.environmentId,
        message: expect.stringContaining("Update this app to see usage from New server"),
      },
      { environmentId: "failed", message: "Could not load usage from Failed server. Try again." },
      { environmentId: "loading", message: "Waiting for usage from Loading server." },
      { environmentId: "offline", message: "Connect to Offline server to load its usage." },
    ]);

    const denied = usage([
      {
        ...mac,
        summary: null,
        isConnected: true,
        canReadDiagnostics: false,
        error: "This connection does not have access to diagnostics and usage.",
      },
    ]).availability;
    expect(denied.isLoading).toBe(false);
    expect(denied.hasCompatibleSummary).toBe(false);
    expect(denied.canRetry).toBe(false);

    for (const selected of [environments.slice(3), environments.slice(2), environments.slice(1)]) {
      const { merged, availability: pending } = usage(selected);
      expect(merged.costUsd).toBe(0);
      expect(merged.totalTokens).toBe(0);
      expect(pending.canRetry).toBe(
        selected.some((environment) => environment.environmentId === "failed"),
      );
      expect(pending.isLoading).toBe(true);
      expect(pending.hasCompatibleSummary).toBe(false);
      expect(pending.notices).toEqual(
        availability.notices.filter(({ environmentId }) =>
          selected.some((environment) => environment.environmentId === environmentId),
        ),
      );
      expect(pending.coverageMessage ?? "").not.toMatch(
        /No usage totals are available|until a compatible environment/i,
      );
    }
  });

  it("keeps saved totals visibly stale after a failure or disconnect and retries only while connected", () => {
    for (const isConnected of [true, false]) {
      const { merged, availability } = usage([{ ...mac, error: "Request failed", isConnected }]);
      expect(merged.costUsd).toBe(10);
      expect(merged.totalTokens).toBe(150);
      expect(availability.hasCompatibleSummary).toBe(true);
      expect(availability.notices).toEqual([
        {
          environmentId: mac.environmentId,
          message: expect.stringContaining("Showing saved usage, which may be out of date."),
        },
      ]);
      expect(availability.notices[0]?.message).toContain(
        isConnected ? "Could not refresh usage from MacBook Pro" : "MacBook Pro is disconnected",
      );
      expect(availability.canRetry).toBe(isConnected);
    }
  });
});
