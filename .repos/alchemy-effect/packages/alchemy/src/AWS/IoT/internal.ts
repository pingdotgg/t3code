import * as iot from "@distilled.cloud/aws/iot";
import * as Effect from "effect/Effect";
import { createInternalTags, diffTags } from "../../Tags.ts";

/**
 * IoT rule names accept only `[a-zA-Z0-9_]`. Coerce any other character
 * (hyphens from generated physical names, colons, etc.) to an underscore so
 * a name derived from the stack/id/stage is always valid.
 */
export const sanitizeRuleName = (name: string): string =>
  name.replace(/[^a-zA-Z0-9_]/g, "_");

/**
 * Reads the observed tag map for an IoT resource ARN. A missing resource
 * yields `{}` so callers treat it as "no tags observed".
 */
export const readIotTags = Effect.fn(function* (resourceArn: string) {
  const { tags } = yield* iot
    .listTagsForResource({ resourceArn })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed({ tags: [] as iot.Tag[] }),
      ),
    );
  const record: Record<string, string> = {};
  for (const tag of tags ?? []) {
    if (tag.Value !== undefined) record[tag.Key] = tag.Value;
  }
  return record;
});

/**
 * Reconciles the tags on an IoT resource to `{ ...user, ...internal }`,
 * diffing against the OBSERVED cloud tags (so adoption converges). Applies
 * only the delta: `tagResource` for upserts, `untagResource` for removals.
 */
export const syncIotTags = Effect.fn(function* (
  resourceArn: string,
  id: string,
  userTags: Record<string, string> | undefined,
) {
  const internalTags = yield* createInternalTags(id);
  const desired = { ...userTags, ...internalTags };
  const observed = yield* readIotTags(resourceArn);
  const { upsert, removed } = diffTags(observed, desired);
  if (upsert.length > 0) {
    yield* iot.tagResource({
      resourceArn,
      tags: upsert.map((t) => ({ Key: t.Key, Value: t.Value })),
    });
  }
  if (removed.length > 0) {
    yield* iot.untagResource({ resourceArn, tagKeys: removed });
  }
});
