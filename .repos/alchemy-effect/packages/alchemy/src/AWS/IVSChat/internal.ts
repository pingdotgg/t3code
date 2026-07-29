import * as ivschat from "@distilled.cloud/aws/ivschat";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { diffTags } from "../../Tags.ts";

/**
 * IVS Chat wire tags allow `undefined` values in the record type —
 * flatten to a plain string record, dropping malformed entries.
 */
export const toTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

/**
 * Read the observed tags of an IVS Chat resource. Best-effort — a
 * failure (e.g. a race with deletion) reports no tags.
 */
export const readIvsChatTags = Effect.fn(function* (arn: string) {
  const response = yield* ivschat
    .listTagsForResource({ resourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.tags);
});

/**
 * Sync tags on an IVS Chat resource: diff the OBSERVED cloud tags
 * against the desired set and apply only the delta.
 */
export const syncIvsChatTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readIvsChatTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* ivschat
      .tagResource({
        resourceArn: arn,
        tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
      })
      .pipe(retryWhileThrottled);
  }
  if (removed.length > 0) {
    yield* ivschat
      .untagResource({ resourceArn: arn, tagKeys: removed })
      .pipe(retryWhileThrottled);
  }
});

/**
 * Explicitly-typed pipeable retry helper (inlined `Effect.retry` in a
 * provider op widens the layer type in declaration emit). Retries
 * `ConflictException` — e.g. mutating or deleting a logging
 * configuration while it is mid-state-transition — on a bounded schedule.
 */
export const retryWhileConflict = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
  });

/**
 * Retries the `ValidationException` IVS Chat raises while a freshly-added
 * `lambda:InvokeFunction` permission for `ivschat.amazonaws.com` is still
 * propagating — associating a `messageReviewHandler` validates the
 * permission, and Create/UpdateRoom can race the IAM propagation window
 * ("Request member: uri failed to satisfy the constraints: invalid lambda
 * permission"). Bounded (~30s).
 */
export const retryWhileHandlerPermissionPropagating = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e): boolean =>
      e instanceof ivschat.ValidationException &&
      e.message.includes("invalid lambda permission"),
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
  });

/**
 * Retries `ThrottlingException` on a bounded exponential schedule. IVS
 * APIs have very low TPS limits (e.g. ListPlaybackKeyPairs is 1 TPS), so
 * back-to-back reconciles routinely trip 429s.
 */
export const retryWhileThrottled = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ThrottlingException",
    schedule: Schedule.max([
      Schedule.exponential("1 second"),
      Schedule.recurs(6),
    ]),
  });
