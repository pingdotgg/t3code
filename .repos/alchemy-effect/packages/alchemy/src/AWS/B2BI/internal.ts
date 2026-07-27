import * as b2bi from "@distilled.cloud/aws/b2bi";
import * as Effect from "effect/Effect";
import { diffTags } from "../../Tags.ts";

/**
 * Convert a B2BI wire tag list (`{ Key, Value }[]`) into a plain record,
 * dropping malformed entries.
 */
export const toTagRecord = (
  tags: ReadonlyArray<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

/**
 * Convert a desired tag record into the B2BI wire tag list for create calls.
 */
export const toWireTags = (tags: Record<string, string>): b2bi.Tag[] =>
  Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

/**
 * Read the observed tags of a B2BI resource. Tag reads are best-effort —
 * a failure (e.g. a race with deletion) reports no tags.
 */
export const readB2biTags = Effect.fn(function* (arn: string) {
  const response = yield* b2bi
    .listTagsForResource({ ResourceARN: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.Tags);
});

/**
 * Sync tags on a B2BI resource: diff the OBSERVED cloud tags against the
 * desired set and apply only the delta.
 */
export const syncB2biTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readB2biTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* b2bi.tagResource({ ResourceARN: arn, Tags: upsert });
  }
  if (removed.length > 0) {
    yield* b2bi.untagResource({ ResourceARN: arn, TagKeys: removed });
  }
});
