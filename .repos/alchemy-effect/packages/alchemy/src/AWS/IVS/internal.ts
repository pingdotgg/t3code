import * as ivs from "@distilled.cloud/aws/ivs";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { diffTags } from "../../Tags.ts";

/**
 * IVS wire tags allow `undefined` values in the record type — flatten to a
 * plain string record, dropping malformed entries.
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
 * Read the observed tags of an IVS resource. Tag reads are best-effort —
 * a failure (e.g. a race with deletion) reports no tags.
 */
export const readIvsTags = Effect.fn(function* (arn: string) {
  const response = yield* ivs
    .listTagsForResource({ resourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.tags);
});

/**
 * Sync tags on an IVS resource: diff the OBSERVED cloud tags against the
 * desired set and apply only the delta.
 */
export const syncIvsTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readIvsTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* ivs
      .tagResource({
        resourceArn: arn,
        tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
      })
      .pipe(retryWhileThrottled);
  }
  if (removed.length > 0) {
    yield* ivs
      .untagResource({ resourceArn: arn, tagKeys: removed })
      .pipe(retryWhileThrottled);
  }
});

/**
 * Explicitly-typed pipeable retry helper. Inlining `Effect.retry` in a
 * provider op lets `Retry.Return`'s conditional type survive into
 * declaration emit and widens the provider layer to `unknown` for every
 * `AWS.providers()` consumer — keep the annotation explicit.
 *
 * Retries `ConflictException` (e.g. deleting a channel while a stream is
 * live, or a resource is mid-transition) on a bounded schedule.
 */
export const retryWhileConflict = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
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
