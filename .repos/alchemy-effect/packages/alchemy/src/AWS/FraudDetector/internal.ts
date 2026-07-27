import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import * as Effect from "effect/Effect";
import { diffTags } from "../../Tags.ts";

/**
 * Coerce a FraudDetector wire tag list (`{ key, value }[]`) into a plain
 * `Record<string, string>`.
 */
export const toTagRecord = (
  tags: frauddetector.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [t.key, t.value] as const));

/**
 * Read the observed tags of a FraudDetector resource by ARN. Tag reads are
 * best-effort — a failure (e.g. a race with deletion) reports no tags.
 */
export const readFraudDetectorTags = Effect.fn(function* (arn: string) {
  const response = yield* frauddetector
    .listTagsForResource({ resourceARN: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.tags);
});

/**
 * Sync tags on a FraudDetector resource: diff the OBSERVED cloud tags against
 * the desired set and apply only the delta.
 */
export const syncFraudDetectorTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readFraudDetectorTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* frauddetector.tagResource({
      resourceARN: arn,
      tags: upsert.map((t) => ({ key: t.Key, value: t.Value })),
    });
  }
  if (removed.length > 0) {
    yield* frauddetector.untagResource({ resourceARN: arn, tagKeys: removed });
  }
});
