import * as backupsearch from "@distilled.cloud/aws/backupsearch";
import * as Effect from "effect/Effect";
import { diffTags } from "../../Tags.ts";

/**
 * Coerce a BackupSearch wire tag map (a sparse `Record<string, string |
 * undefined>`) into a plain `Record<string, string>`.
 */
export const toTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/**
 * Read the observed tags of a BackupSearch resource by ARN. Tag reads are
 * best-effort — a failure (e.g. a race with job expiry) reports no tags.
 */
export const readBackupSearchTags = Effect.fn(function* (arn: string) {
  const response = yield* backupsearch
    .listTagsForResource({ ResourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.Tags);
});

/**
 * Sync tags on a BackupSearch resource: diff the OBSERVED cloud tags against
 * the desired set and apply only the delta.
 */
export const syncBackupSearchTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readBackupSearchTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* backupsearch.tagResource({
      ResourceArn: arn,
      Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
    });
  }
  if (removed.length > 0) {
    yield* backupsearch.untagResource({ ResourceArn: arn, TagKeys: removed });
  }
});
