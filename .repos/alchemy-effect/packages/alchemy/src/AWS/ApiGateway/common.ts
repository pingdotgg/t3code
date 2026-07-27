import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Retry from "@distilled.cloud/aws/Retry";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { diffTags, normalizeTags } from "../../Tags.ts";

/**
 * API Gateway serializes mutations to a single RestApi at the control-plane
 * level: while the API is transitioning between states it responds with a
 * `BadRequestException` whose message matches one of:
 *
 * - `You cannot deploy a RestApi while the apiStatus is UPDATING or FAILED.`
 * - `There is already an update in progress.`
 *
 * These are fundamentally transient — the retry window is short (seconds)
 * and the only correct response is to wait and try again. Because the
 * exception is a 4xx, the generic `Retry.transient` policy applied to the
 * AWS SDK will not retry it, so we apply a targeted retry here for
 * operations that race with concurrent mutations on the same RestApi
 * (typically `createDeployment`, `updateStage`, `deleteStage`).
 */
const isApiStatusUpdatingError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  if ((error as { _tag?: string })._tag !== "BadRequestException") return false;
  const message = (error as { message?: string }).message ?? "";
  return (
    message.includes("apiStatus is UPDATING") ||
    message.includes("already an update in progress")
  );
};

/**
 * Schedule for API Gateway's transient API-status conflicts. Throttling is
 * deliberately not retried here: the shared AWS client policy already has a
 * bounded, capped retry window long enough to cross API Gateway's ~30-second
 * mutation quota. Retrying throttling again at this layer would nest the two
 * policies and turn one operation into a many-minute wait.
 */
const apiGatewayMutationSchedule = Schedule.max([
  Schedule.spaced("5 seconds"),
  Schedule.recurs(10),
]);

/**
 * Wraps an API Gateway mutation so that recoverable 4xx responses are
 * retried with backoff:
 *
 * - `BadRequestException` with `apiStatus is UPDATING` or
 *   `already an update in progress` (transient, clears in seconds)
 *
 * Drop-in usage:
 *
 * ```ts
 * yield* retryOnApiStatusUpdating(
 *   ag.createDeployment({ ... }),
 * );
 * ```
 */
export const retryOnApiStatusUpdating = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(effect, {
    schedule: apiGatewayMutationSchedule,
    while: isApiStatusUpdatingError,
  }) as Effect.Effect<A, E, R>;

const isRestApiDeleteRetryable = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const tagged = error as { _tag?: string; message?: string };
  return (
    tagged._tag === "TooManyRequestsException" ||
    tagged._tag === "ConflictException" ||
    (tagged._tag === "BadRequestException" &&
      (tagged.message?.includes("apiStatus is UPDATING") === true ||
        tagged.message?.includes("already an update in progress") === true))
  );
};

// DeleteRestApi has its own unusually low regional quota (roughly one request
// every 30 seconds). Override the blanket AWS retry layer for this operation:
// otherwise its 5-second-capped budget expires after about a minute, and then
// wrapping that exhausted call in another retry schedule creates an opaque,
// nested multi-minute wait. This is one explicit 90-second wall instead.
const restApiDeleteSchedule = Schedule.max([
  Schedule.spaced("5 seconds"),
  Schedule.recurs(18),
]);

class RestApiStillExists extends Data.TaggedError("RestApiStillExists")<{
  readonly restApiId: string;
}> {}

const restApiGoneSchedule = Schedule.max([
  Schedule.spaced("1 second"),
  Schedule.recurs(8),
]);

/**
 * Idempotently delete a REST API and observe it disappear.
 *
 * Every provider/test cleanup path uses this helper so nuke, normal destroy,
 * and interrupted-run reapers all share the same bounded throttle handling.
 */
export const deleteRestApiAndWait = Effect.fn(function* (restApiId: string) {
  yield* ag.deleteRestApi({ restApiId }).pipe(
    Retry.policy({
      while: isRestApiDeleteRetryable,
      schedule: restApiDeleteSchedule,
    }),
    Effect.catchTag("NotFoundException", () => Effect.void),
  );

  // Avoid nesting the account-wide AWS retry policy inside the observable
  // poll. Each getRestApi is single-shot; this one bounded schedule owns both
  // throttled reads and the short eventual-consistency window.
  const observe = Retry.none(ag.getRestApi({ restApiId }));
  yield* observe.pipe(
    Effect.flatMap(() => Effect.fail(new RestApiStillExists({ restApiId }))),
    Effect.retry({
      while: (error) =>
        error._tag === "TooManyRequestsException" ||
        error._tag === "RestApiStillExists",
      schedule: restApiGoneSchedule,
    }),
    Effect.catchTag("NotFoundException", () => Effect.void),
  );
});

export const restApiArn = (region: string, restApiId: string) =>
  `arn:aws:apigateway:${region}::/restapis/${restApiId}`;

export const stageArn = (
  region: string,
  restApiId: string,
  stageName: string,
) => `arn:aws:apigateway:${region}::/restapis/${restApiId}/stages/${stageName}`;

export const apiKeyArn = (region: string, apiKeyId: string) =>
  `arn:aws:apigateway:${region}::/apikeys/${apiKeyId}`;

export const usagePlanArn = (region: string, usagePlanId: string) =>
  `arn:aws:apigateway:${region}::/usageplans/${usagePlanId}`;

export const domainNameArn = (region: string, domainName: string) =>
  `arn:aws:apigateway:${region}::/domainnames/${domainName}`;

export const vpcLinkArn = (region: string, vpcLinkId: string) =>
  `arn:aws:apigateway:${region}::/vpclinks/${vpcLinkId}`;

export const syncTags = Effect.fn(function* ({
  resourceArn,
  oldTags,
  newTags,
}: {
  resourceArn: string;
  oldTags: Record<string, string>;
  newTags: Record<string, string>;
}) {
  const { removed, upsert } = diffTags(oldTags, newTags);
  if (removed.length > 0) {
    yield* ag
      .untagResource({
        resourceArn,
        tagKeys: removed,
      })
      .pipe(
        Effect.catchTag("NotFoundException", () => Effect.void),
        Effect.catchTag("BadRequestException", () => Effect.void),
      );
  }
  if (upsert.length > 0) {
    yield* ag.tagResource({
      resourceArn,
      tags: normalizeTags(upsert),
    });
  }
});
