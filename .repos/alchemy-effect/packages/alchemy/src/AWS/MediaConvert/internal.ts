import * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import * as Effect from "effect/Effect";
import { diffTags } from "../../Tags.ts";

/**
 * Coerce a MediaConvert wire tag map (values are `string | undefined`) into a
 * plain `Record<string, string>`, dropping any undefined values.
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
 * Read the observed tags of a MediaConvert resource by ARN. Tag reads are
 * best-effort — a failure (e.g. a race with deletion) reports no tags.
 */
export const readMcTags = Effect.fn(function* (arn: string) {
  const response = yield* mediaconvert
    .listTagsForResource({ Arn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.ResourceTags?.Tags);
});

/**
 * Sync tags on a MediaConvert resource: diff the OBSERVED cloud tags against
 * the desired set and apply only the delta. MediaConvert's `tagResource`
 * takes a tag map keyed by ARN in the body; `untagResource` takes an ARN path
 * label plus the keys to remove.
 */
export const syncMcTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readMcTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* mediaconvert.tagResource({
      Arn: arn,
      Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
    });
  }
  if (removed.length > 0) {
    yield* mediaconvert.untagResource({ Arn: arn, TagKeys: removed });
  }
});
