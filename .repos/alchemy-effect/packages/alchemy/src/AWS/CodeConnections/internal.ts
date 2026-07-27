import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import * as Effect from "effect/Effect";
import { diffTags } from "../../Tags.ts";

/**
 * Shared tag plumbing for the CodeConnections resources (Connection, Host,
 * RepositoryLink). All three share the same `TagResource`/`UntagResource`/
 * `ListTagsForResource` wire shape keyed by ARN.
 *
 * NOT exported from `index.ts`.
 */

/** Convert a CodeConnections wire tag list into a plain record. */
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

/** Convert a plain record into the CodeConnections wire tag list. */
export const toTagList = (
  tags: Record<string, string>,
): { Key: string; Value: string }[] =>
  Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

/** Read the observed cloud tags for a CodeConnections resource ARN. */
export const fetchObservedTags = Effect.fn(function* (arn: string) {
  return yield* codeconnections.listTagsForResource({ ResourceArn: arn }).pipe(
    Effect.map((res) => toTagRecord(res.Tags)),
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed({})),
  );
});

/**
 * Converge a CodeConnections resource's tags to `desiredTags`, diffing
 * against the OBSERVED cloud tags (adoption may bring foreign tags).
 */
export const syncResourceTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observed = yield* fetchObservedTags(arn);
  const { removed, upsert } = diffTags(observed, desiredTags);
  if (upsert.length > 0) {
    yield* codeconnections.tagResource({ ResourceArn: arn, Tags: upsert });
  }
  if (removed.length > 0) {
    yield* codeconnections.untagResource({
      ResourceArn: arn,
      TagKeys: removed,
    });
  }
});
