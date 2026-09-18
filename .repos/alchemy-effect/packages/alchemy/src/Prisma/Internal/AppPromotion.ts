import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import {
  getService,
  createServicePromote,
  createServiceRollback,
} from "@distilled.cloud/prisma/management";
import type { ObservedApp } from "./Observed.ts";
import type { PromoteAppResult } from "../Types.ts";

export interface AppDeploymentTargetObservationOptions {
  readonly timeoutSeconds?: number;
  readonly pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export const waitForAppDeploymentTarget = Effect.fn(function* (
  appId: string,
  deploymentId: string,
  options: AppDeploymentTargetObservationOptions = {},
) {
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return yield* Effect.fail(
      new Error("timeoutSeconds must be a positive finite number."),
    );
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return yield* Effect.fail(
      new Error("pollIntervalMs must be a positive finite number."),
    );
  }

  const timeoutMs = timeoutSeconds * 1_000;
  const deadline = yield* Effect.sync(() => Date.now() + timeoutMs);
  let lastLatestDeploymentId: string | null | undefined;
  let lastError: unknown;

  while (true) {
    const remainingBeforeObservation = yield* Effect.sync(
      () => deadline - Date.now(),
    );
    if (remainingBeforeObservation <= 0) break;

    const observationOption = yield* getService({ serviceId: appId }).pipe(
      Effect.map((response) => response.data),
      Effect.result,
      Effect.timeoutOption(Duration.millis(remainingBeforeObservation)),
    );
    if (Option.isNone(observationOption)) break;
    const observation = observationOption.value;
    if (Result.isSuccess(observation)) {
      lastLatestDeploymentId = observation.success.latestDeploymentId;
      lastError = undefined;
      if (lastLatestDeploymentId === deploymentId) {
        return observation.success;
      }
    } else {
      lastError = observation.failure;
    }

    const remainingAfterObservation = yield* Effect.sync(
      () => deadline - Date.now(),
    );
    if (remainingAfterObservation <= 0) break;
    yield* Effect.sleep(
      Duration.millis(Math.min(intervalMs, remainingAfterObservation)),
    );
  }

  return yield* Effect.fail(
    new AggregateError(
      lastError === undefined ? [] : [lastError],
      `Timed out waiting for Prisma App '${appId}' to report deployment '${deploymentId}' as latest (last observed latest deployment: '${lastLatestDeploymentId ?? "none"}').`,
    ),
  );
});

/**
 * Promote an App and recover response loss by observing the canonical App.
 * Every successful mutation is followed by bounded observation of the App
 * row before callers may probe stable readiness or delete another deployment.
 * If the promotion response is lost, the canonical rollback primitive heals
 * an already-flipped Foundry endpoint or safely completes the target
 * promotion. Any non-converged result is ambiguous and must never trigger
 * target deletion.
 */
export const promoteAppObserved = Effect.fn(function* (
  appId: string,
  deploymentId: string,
  options: AppDeploymentTargetObservationOptions = {},
) {
  const promoted = yield* createServicePromote({
    serviceId: appId,
    deploymentId,
  }).pipe(
    Effect.map((response) => response.data),
    Effect.result,
  );
  if (Result.isSuccess(promoted)) {
    const observation = yield* waitForAppDeploymentTarget(
      appId,
      deploymentId,
      options,
    ).pipe(Effect.result);
    if (Result.isFailure(observation)) {
      return yield* Effect.fail(
        new AggregateError(
          [observation.failure],
          `Prisma App '${appId}' promotion returned success for deployment '${deploymentId}', but the App did not converge to that target. The deployment was preserved because promotion commit state is ambiguous.`,
        ),
      );
    }
    return {
      ...promoted.success,
      appEndpointDomain: observation.success.appEndpointDomain,
    };
  }

  const observation = yield* getService({ serviceId: appId }).pipe(
    Effect.map((response) => response.data),
    Effect.result,
  );
  if (
    Result.isSuccess(observation) &&
    observation.success.latestDeploymentId === deploymentId
  ) {
    return {
      appEndpointDomain: observation.success.appEndpointDomain,
      reassignedDomains: 0,
    };
  }
  const repaired = yield* createServiceRollback({
    serviceId: appId,
    deploymentId,
  }).pipe(
    Effect.map((response) => response.data),
    Effect.result,
  );
  const repairedObservation = Result.isSuccess(repaired)
    ? yield* waitForAppDeploymentTarget(appId, deploymentId, options).pipe(
        Effect.result,
      )
    : yield* getService({ serviceId: appId }).pipe(
        Effect.map((response) => response.data),
        Effect.result,
      );
  if (
    Result.isSuccess(repairedObservation) &&
    repairedObservation.success.latestDeploymentId === deploymentId
  ) {
    return Result.isSuccess(repaired)
      ? {
          ...repaired.success,
          appEndpointDomain: repairedObservation.success.appEndpointDomain,
        }
      : {
          appEndpointDomain: repairedObservation.success.appEndpointDomain,
          reassignedDomains: 0,
        };
  }
  return yield* Effect.fail(
    new AggregateError(
      [
        promoted.failure,
        ...(Result.isFailure(observation) ? [observation.failure] : []),
        ...(Result.isFailure(repaired) ? [repaired.failure] : []),
        ...(Result.isFailure(repairedObservation)
          ? [repairedObservation.failure]
          : [
              new Error(
                `Prisma App '${appId}' still reports deployment '${repairedObservation.success.latestDeploymentId ?? "none"}' as latest after canonical recovery targeted '${deploymentId}'.`,
              ),
            ]),
      ],
      `Prisma App '${appId}' promotion of deployment '${deploymentId}' failed and canonical recovery also failed. The deployment was not deleted because endpoint commit state is ambiguous.`,
    ),
  );
});
