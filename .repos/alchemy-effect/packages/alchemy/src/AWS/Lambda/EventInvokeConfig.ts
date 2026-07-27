import * as Lambda from "@distilled.cloud/aws/lambda";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { deepEqual } from "../../Diff.ts";
import { toWireSeconds } from "../../Util/Duration.ts";

const DEFAULT_MAXIMUM_RETRY_ATTEMPTS = 2;
const DEFAULT_MAXIMUM_EVENT_AGE_SECONDS = 21_600;

/**
 * Asynchronous invocation settings for a Lambda function or alias.
 *
 * Configured via {@link FunctionProps.eventInvokeConfig} for the unqualified
 * function, or {@link AliasProps.eventInvokeConfig} for a specific alias.
 */
export interface EventInvokeConfig {
  /**
   * Maximum number of times Lambda retries an asynchronous invocation.
   * @default 2
   */
  maximumRetryAttempts?: number;
  /**
   * Maximum age that Lambda retains an asynchronous event (e.g. `"6 hours"`).
   * Rounded to whole seconds on the wire.
   * @default "6 hours"
   */
  maximumEventAge?: Duration.Input;
  /**
   * Destinations for successful or failed asynchronous invocation records.
   */
  destinationConfig?: Lambda.DestinationConfig;
}

const retryOnConflict = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "ResourceConflictException",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );

const normalizeDestinationConfig = (
  config: Lambda.DestinationConfig | undefined,
): Lambda.DestinationConfig | undefined => {
  const onSuccess = config?.OnSuccess?.Destination
    ? { Destination: config.OnSuccess.Destination }
    : undefined;
  const onFailure = config?.OnFailure?.Destination
    ? { Destination: config.OnFailure.Destination }
    : undefined;
  return onSuccess || onFailure
    ? {
        OnSuccess: onSuccess,
        OnFailure: onFailure,
      }
    : undefined;
};

const observeConfig = (functionName: string, qualifier: string | undefined) =>
  Lambda.getFunctionEventInvokeConfig({
    FunctionName: functionName,
    Qualifier: qualifier,
  }).pipe(
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

/**
 * Converge the async invocation config of a function or alias to the desired
 * state: put it when set, delete it when omitted. Diffs against the observed
 * cloud config so a no-op deploy skips the write entirely.
 */
export const syncEventInvokeConfig = Effect.fn(function* ({
  functionName,
  qualifier,
  config,
}: {
  functionName: string;
  /** Alias name (or version) to scope the config to. Omit for `$LATEST`. */
  qualifier?: string;
  config: EventInvokeConfig | undefined;
}) {
  const observed = yield* observeConfig(functionName, qualifier);

  if (config === undefined) {
    if (observed) {
      yield* retryOnConflict(
        Lambda.deleteFunctionEventInvokeConfig({
          FunctionName: functionName,
          Qualifier: qualifier,
        }),
      ).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
    }
    return;
  }

  const desired = {
    maximumRetryAttempts:
      config.maximumRetryAttempts ?? DEFAULT_MAXIMUM_RETRY_ATTEMPTS,
    maximumEventAgeSeconds:
      toWireSeconds(config.maximumEventAge) ??
      DEFAULT_MAXIMUM_EVENT_AGE_SECONDS,
    destinationConfig: normalizeDestinationConfig(config.destinationConfig),
  };

  if (
    observed &&
    (observed.MaximumRetryAttempts ?? DEFAULT_MAXIMUM_RETRY_ATTEMPTS) ===
      desired.maximumRetryAttempts &&
    (observed.MaximumEventAgeInSeconds ?? DEFAULT_MAXIMUM_EVENT_AGE_SECONDS) ===
      desired.maximumEventAgeSeconds &&
    deepEqual(
      normalizeDestinationConfig(observed.DestinationConfig),
      desired.destinationConfig,
    )
  ) {
    return;
  }

  yield* Lambda.putFunctionEventInvokeConfig({
    FunctionName: functionName,
    Qualifier: qualifier,
    MaximumRetryAttempts: desired.maximumRetryAttempts,
    MaximumEventAgeInSeconds: desired.maximumEventAgeSeconds,
    DestinationConfig: desired.destinationConfig,
  }).pipe(
    Effect.retry({
      while: (
        e,
      ): e is
        | Lambda.ResourceConflictException
        | Lambda.InvalidParameterValueException =>
        e._tag === "ResourceConflictException" ||
        // Destination validation races IAM policy propagation on the
        // execution role — Lambda rejects the put until the role can reach
        // the destination.
        (e._tag === "InvalidParameterValueException" &&
          (e.message?.includes(
            "The function execution role does not have permissions to call",
          ) ??
            false)),
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );
});
