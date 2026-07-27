import * as r53r from "@distilled.cloud/aws/route53resolver";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { diffTags } from "../../Tags.ts";

/**
 * Fetch the observed tags on a Route 53 Resolver resource as a plain record.
 * Any failure (e.g. the resource vanished between observation and the tag
 * read, or the resource is an AWS-managed rule we cannot read tags for)
 * degrades to an empty record so callers can still converge.
 *
 * @internal
 */
export const fetchResolverTags = (arn: string) =>
  r53r.listTagsForResource.items({ ResourceArn: arn }).pipe(
    Stream.runCollect,
    Effect.map(
      (chunk) =>
        Object.fromEntries(
          Array.from(chunk).map((tag) => [tag.Key, tag.Value]),
        ) as Record<string, string>,
    ),
    Effect.catch(() => Effect.succeed({} as Record<string, string>)),
  );

/**
 * Converge the tags on a Route 53 Resolver resource to `desired`, diffing
 * against the OBSERVED cloud tags (never olds/output) so adoption converges.
 *
 * @internal
 */
export const syncResolverTags = Effect.fn(function* (
  arn: string,
  desired: Record<string, string>,
) {
  const observed = yield* fetchResolverTags(arn);
  const { upsert, removed } = diffTags(observed, desired);
  if (upsert.length > 0) {
    yield* r53r.tagResource({ ResourceArn: arn, Tags: upsert });
  }
  if (removed.length > 0) {
    yield* r53r.untagResource({ ResourceArn: arn, TagKeys: removed });
  }
});

/**
 * Convert a tag record into the wire `Tag[]` shape for create calls.
 *
 * @internal
 */
export const toResolverTagList = (tags: Record<string, string>): r53r.Tag[] =>
  Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

/**
 * Order-insensitive string set equality.
 *
 * @internal
 */
export const sameStringSet = (
  a: readonly string[],
  b: readonly string[],
): boolean => {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, i) => value === sortedB[i]);
};
