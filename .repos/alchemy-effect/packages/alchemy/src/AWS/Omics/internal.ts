import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import { diffTags, tagRecord } from "../../Tags.ts";

/**
 * Reads the observed tags for a HealthOmics resource by ARN. Tolerates a
 * not-found race (the resource can vanish between observation and this call)
 * by returning an empty map.
 *
 * NOT exported from the service barrel — shared scaffolding for the Omics
 * resource providers only.
 */
export const fetchOmicsTags = Effect.fn(function* (resourceArn: string) {
  return yield* omics.listTagsForResource({ resourceArn }).pipe(
    Effect.map((r) => tagRecord(r.tags)),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed({} as Record<string, string>),
    ),
  );
});

/**
 * Converges the tags on a HealthOmics resource to `desired`, diffing against
 * the OBSERVED cloud tags (not olds/output) so adoption converges. Applies
 * only the delta: `tagResource` for upserts, `untagResource` for removals.
 */
export const syncOmicsTags = Effect.fn(function* (
  resourceArn: string,
  desired: Record<string, string>,
) {
  const current = yield* fetchOmicsTags(resourceArn);
  const { upsert, removed } = diffTags(current, desired);
  if (upsert.length > 0) {
    yield* omics.tagResource({
      resourceArn,
      tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
    });
  }
  if (removed.length > 0) {
    yield* omics.untagResource({ resourceArn, tagKeys: removed });
  }
});
