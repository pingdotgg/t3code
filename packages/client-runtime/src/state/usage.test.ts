import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type UsageDay,
  type UsageSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { deriveUsageState, environmentUsageStatus, type EnvironmentUsageStatus } from "./usage.ts";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");

function summary(costUsd: number, contractVersion: number = USAGE_CONTRACT_VERSION): UsageSummary {
  return {
    contractVersion,
    readAt: "2026-08-09T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-08-01" as UsageDay,
    untilDay: "2026-08-09" as UsageDay,
    buckets: [
      {
        day: "2026-08-09" as UsageDay,
        provider: "claude",
        model: "claude-fable-5",
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 50,
          reasoningTokens: 0,
        },
        costUsd,
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
          hostId: `host-${costUsd}`,
          provider: "claude",
          resolvedHomePath: `/home/${costUsd}/.claude`,
          volumeId: `volume-${costUsd}`,
        },
        status: "ok",
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 1,
        message: null,
      },
    ],
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 1,
  };
}

function status(
  environmentId: typeof ENVIRONMENT_A,
  result: AsyncResult.AsyncResult<UsageSummary, string>,
): EnvironmentUsageStatus {
  return environmentUsageStatus({ environmentId, label: environmentId, result });
}

describe("usage state", () => {
  it("treats a waiting failure as reporting during retry", () => {
    const failed = AsyncResult.failure<UsageSummary, string>(Cause.fail("offline"));
    const retrying = status(ENVIRONMENT_B, AsyncResult.waitingFrom(Option.some(failed)));

    expect(retrying).toMatchObject({
      isPending: true,
      error: null,
      summary: null,
    });
    expect(deriveUsageState([retrying])).toMatchObject({
      isPending: true,
      isPartial: false,
    });

    const partial = deriveUsageState([
      status(ENVIRONMENT_A, AsyncResult.success(summary(10))),
      retrying,
    ]);
    expect(partial).toMatchObject({ isPending: false, isPartial: true });
    expect(partial.merged.costUsd).toBe(10);
  });

  it("renders partial totals, then excludes a failed environment's previous success", () => {
    const pendingA = status(ENVIRONMENT_A, AsyncResult.initial(true));
    const pendingB = status(ENVIRONMENT_B, AsyncResult.initial(true));
    expect(deriveUsageState([pendingA, pendingB])).toMatchObject({
      isPending: true,
      isPartial: false,
    });

    const loadedA = status(ENVIRONMENT_A, AsyncResult.success(summary(10)));
    const partial = deriveUsageState([loadedA, pendingB]);
    expect(partial).toMatchObject({ isPending: false, isPartial: true });
    expect(partial.merged.costUsd).toBe(10);

    const previousB = AsyncResult.success<UsageSummary, string>(summary(20));
    const failedB = status(
      ENVIRONMENT_B,
      AsyncResult.failure(Cause.fail("offline"), {
        previousSuccess: Option.some(previousB),
      }),
    );
    const settled = deriveUsageState([loadedA, failedB]);

    expect(failedB).toMatchObject({
      isPending: false,
      error: "This environment could not report usage.",
      summary: null,
    });
    expect(settled).toMatchObject({ isPending: false, isPartial: false });
    expect(settled.merged.costUsd).toBe(10);
    expect(settled.merged.contributingEnvironments).toEqual([ENVIRONMENT_A]);
  });

  it("keeps the initial placeholder when only an incompatible environment has answered", () => {
    const incompatible = status(
      ENVIRONMENT_A,
      AsyncResult.success(summary(10, USAGE_CONTRACT_VERSION - 1)),
    );
    const state = deriveUsageState([
      incompatible,
      status(ENVIRONMENT_B, AsyncResult.initial(true)),
    ]);

    expect(state).toMatchObject({ isPending: true, isPartial: false });
    expect(state.merged.costUsd).toBe(0);
    expect(state.merged.staleEnvironments).toEqual([ENVIRONMENT_A]);
  });
});
