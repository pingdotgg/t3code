import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageDay,
  type UsageSummary,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { describe, expect, it } from "vite-plus/test";

import { deriveEnvironmentUsageStatus, deriveUsageSettlingState } from "./usageStatus";

const summary: UsageSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-08-09T00:00:00.000Z",
  timeZone: "UTC",
  sinceDay: "2026-08-01" as UsageDay,
  untilDay: "2026-08-09" as UsageDay,
  buckets: [],
  sources: [],
  pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 0 },
  scanDurationMs: 1,
};

const freshSummary: UsageSummary = {
  ...summary,
  readAt: "2026-08-09T00:01:00.000Z",
  scanDurationMs: 2,
};

function status(
  environmentId: string,
  connectionPhase: EnvironmentConnectionPhase,
  result: AsyncResult.AsyncResult<UsageSummary, string>,
) {
  return deriveEnvironmentUsageStatus({
    environmentId: environmentId as EnvironmentId,
    label: environmentId,
    connectionPhase,
    result,
  });
}

describe("usage status", () => {
  it("settles a refresh only after every environment answers the new request", () => {
    const macRefreshing = status(
      "mac",
      "connected",
      AsyncResult.success<UsageSummary, string>(summary, { waiting: true }),
    );
    const linuxRefreshing = status(
      "linux",
      "connected",
      AsyncResult.success<UsageSummary, string>(summary, { waiting: true }),
    );

    expect(macRefreshing.summary).toBe(summary);
    expect(deriveUsageSettlingState([macRefreshing, linuxRefreshing])).toEqual({
      isPending: true,
      isPartial: false,
    });

    const macFinished = status("mac", "connected", AsyncResult.success(summary));
    expect(deriveUsageSettlingState([macFinished, linuxRefreshing])).toEqual({
      isPending: false,
      isPartial: true,
    });

    const linuxFinished = status("linux", "connected", AsyncResult.success(summary));
    expect(deriveUsageSettlingState([macFinished, linuxFinished])).toEqual({
      isPending: false,
      isPartial: false,
    });
  });

  it("waits while an environment makes its initial connection", () => {
    expect(
      status("connecting", "connecting", AsyncResult.initial<UsageSummary, string>(true)),
    ).toEqual(expect.objectContaining({ isPending: true, error: null, summary: null }));
  });

  it("waits for a connected environment's first usage result", () => {
    expect(status("connected", "connected", AsyncResult.initial<UsageSummary, string>())).toEqual(
      expect.objectContaining({ isPending: true, error: null, summary: null }),
    );
  });

  it("waits through reconnect and a fresh scan before completing", () => {
    const reconnecting = status("laptop", "reconnecting", AsyncResult.success(summary));
    const refreshing = status(
      "laptop",
      "connected",
      AsyncResult.success<UsageSummary, string>(summary, { waiting: true }),
    );
    const refreshed = status("laptop", "connected", AsyncResult.success(freshSummary));

    expect(reconnecting).toEqual(
      expect.objectContaining({ isPending: true, error: null, summary }),
    );
    expect(refreshing).toEqual(expect.objectContaining({ isPending: true, error: null, summary }));
    expect(refreshed).toEqual(
      expect.objectContaining({ isPending: false, error: null, summary: freshSummary }),
    );
  });

  it("settles terminal connection phases without a completed summary as failures", () => {
    for (const connectionPhase of ["available", "offline", "error"] as const) {
      expect(
        status("offline", connectionPhase, AsyncResult.initial<UsageSummary, string>(true)),
      ).toEqual(
        expect.objectContaining({
          isPending: false,
          error: "This environment could not report usage.",
          summary: null,
        }),
      );
    }
  });

  it("keeps a completed summary when its environment later disconnects", () => {
    const result = AsyncResult.success<UsageSummary, string>(summary);
    const connected = status("laptop", "connected", result);
    const disconnected = status("laptop", "offline", result);

    expect(connected).toEqual(expect.objectContaining({ isPending: false, error: null, summary }));
    expect(disconnected).toEqual(connected);
  });

  it("drops a retained previous summary when its refresh fails", () => {
    const previous = AsyncResult.success<UsageSummary, string>(summary);
    const retrying = AsyncResult.failWithPrevious("scan failed", {
      previous: Option.some(previous),
      waiting: true,
    });
    const failed = AsyncResult.failWithPrevious("scan failed", {
      previous: Option.some(previous),
    });

    expect(status("desktop", "connected", retrying)).toEqual(
      expect.objectContaining({ isPending: true, error: null, summary }),
    );

    const failedStatus = status("desktop", "connected", failed);
    expect(failedStatus).toEqual(
      expect.objectContaining({
        isPending: false,
        error: "This environment could not report usage.",
        summary: null,
      }),
    );
    expect(deriveUsageSettlingState([failedStatus])).toEqual({
      isPending: false,
      isPartial: false,
    });
  });
});
