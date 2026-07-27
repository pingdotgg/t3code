import * as translate from "@distilled.cloud/aws/translate";
import * as Effect from "effect/Effect";
import { diffTags } from "../../Tags.ts";

/**
 * Coerce a Translate wire tag list (`{ Key, Value }[]`) into a plain
 * `Record<string, string>`.
 */
export const toTagRecord = (
  tags: readonly translate.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [t.Key, t.Value] as const));

/**
 * Read the observed tags of a Translate resource by ARN. Tag reads are
 * best-effort — a failure (e.g. a race with deletion) reports no tags.
 */
export const readTranslateTags = Effect.fn(function* (arn: string) {
  const response = yield* translate
    .listTagsForResource({ ResourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.Tags);
});

/**
 * Sync tags on a Translate resource: diff the OBSERVED cloud tags against the
 * desired set and apply only the delta.
 */
export const syncTranslateTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readTranslateTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* translate.tagResource({
      ResourceArn: arn,
      Tags: upsert.map((t) => ({ Key: t.Key, Value: t.Value })),
    });
  }
  if (removed.length > 0) {
    yield* translate.untagResource({ ResourceArn: arn, TagKeys: removed });
  }
});
