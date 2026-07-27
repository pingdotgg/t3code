import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Effect from "effect/Effect";
import { diffTags } from "../../Tags.ts";

/**
 * Coerce a DataExchange wire tag map (values decode as `string | undefined`)
 * into a plain `Record<string, string>`.
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
 * Read the observed tags of a DataExchange resource by ARN. Tag reads are
 * best-effort — a failure (e.g. a race with deletion) reports no tags.
 */
export const readDataExchangeTags = Effect.fn(function* (arn: string) {
  const response = yield* dataexchange
    .listTagsForResource({ ResourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.Tags);
});

/**
 * Sync tags on a DataExchange resource: diff the OBSERVED cloud tags against
 * the desired set and apply only the delta.
 */
export const syncDataExchangeTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readDataExchangeTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* dataexchange.tagResource({
      ResourceArn: arn,
      Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
    });
  }
  if (removed.length > 0) {
    yield* dataexchange.untagResource({ ResourceArn: arn, TagKeys: removed });
  }
});
