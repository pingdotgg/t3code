import * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { diffTags } from "../../Tags.ts";

/**
 * Flatten the wire `Tag[]` list into a plain string record.
 */
export const toTagRecord = (
  tags: readonly smsvoice.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [t.Key, t.Value]));

/**
 * Convert a plain string record into the wire `Tag[]` list.
 */
export const toTagList = (tags: Record<string, string>): smsvoice.Tag[] =>
  Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

/**
 * Read the observed tags of an End User Messaging SMS resource.
 * Best-effort — a failure (e.g. a race with deletion) reports no tags.
 */
export const readSmsVoiceTags = Effect.fn(function* (arn: string) {
  const response = yield* smsvoice
    .listTagsForResource({ ResourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.Tags);
});

/**
 * Sync tags on an End User Messaging SMS resource: diff the OBSERVED
 * cloud tags against the desired set and apply only the delta.
 */
export const syncSmsVoiceTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readSmsVoiceTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* smsvoice
      .tagResource({ ResourceArn: arn, Tags: upsert })
      .pipe(retrySmsVoiceThrottled);
  }
  if (removed.length > 0) {
    yield* smsvoice
      .untagResource({ ResourceArn: arn, TagKeys: removed })
      .pipe(retrySmsVoiceThrottled);
  }
});

/**
 * Explicitly-typed pipeable retry helper (inlining `Effect.retry` in a
 * provider op widens the layer type in declaration emit). Retries
 * `ThrottlingException` on a bounded exponential schedule — the End User
 * Messaging SMS control plane has low per-account TPS limits.
 */
export const retrySmsVoiceThrottled = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ThrottlingException",
    schedule: Schedule.max([
      Schedule.exponential("1 second"),
      Schedule.recurs(6),
    ]),
  });
