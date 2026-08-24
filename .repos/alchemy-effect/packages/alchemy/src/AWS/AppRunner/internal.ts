import * as apprunner from "@distilled.cloud/aws/apprunner";
import * as Effect from "effect/Effect";
import { diffTags } from "../../Tags.ts";

/**
 * App Runner documents configuration statuses as `ACTIVE`/`INACTIVE` but
 * the wire returns lowercase `active`/`inactive` (observed live for auto
 * scaling configurations and VPC connectors) — compare case-insensitively.
 */
export const isActiveStatus = (status: string | undefined): boolean =>
  status?.toUpperCase() === "ACTIVE";

/**
 * Convert an App Runner wire tag list into a plain record, dropping
 * malformed entries.
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
 * Read the observed tags of an App Runner resource. Tag reads are
 * best-effort — a failure (e.g. a race with deletion) reports no tags.
 */
export const readAppRunnerTags = Effect.fn(function* (arn: string) {
  const response = yield* apprunner
    .listTagsForResource({ ResourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.Tags);
});

/**
 * Sync tags on an App Runner resource: diff the OBSERVED cloud tags
 * against the desired set and apply only the delta.
 */
export const syncAppRunnerTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readAppRunnerTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* apprunner.tagResource({ ResourceArn: arn, Tags: upsert });
  }
  if (removed.length > 0) {
    yield* apprunner.untagResource({ ResourceArn: arn, TagKeys: removed });
  }
});

/**
 * Convert a desired tag record into the wire tag list for create calls.
 */
export const toWireTags = (tags: Record<string, string>): apprunner.Tag[] =>
  Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
