import * as schemas from "@distilled.cloud/aws/schemas";
import * as Effect from "effect/Effect";
import { createInternalTags, diffTags, tagRecord } from "../../Tags.ts";

/**
 * Reads the observed tag map for an EventBridge Schemas resource ARN. A
 * missing resource yields `{}` so callers treat it as "no tags observed".
 */
export const readSchemasTags = Effect.fn(function* (resourceArn: string) {
  const { Tags } = yield* schemas
    .listTagsForResource({ ResourceArn: resourceArn })
    .pipe(
      Effect.catchTag("NotFoundException", () =>
        Effect.succeed({
          Tags: {} as Record<string, string | undefined>,
        }),
      ),
    );
  return tagRecord(Tags);
});

/**
 * Reconciles the tags on a Schemas resource to `{ ...user, ...internal }`,
 * diffing against the OBSERVED cloud tags (so adoption converges). Applies
 * only the delta: `tagResource` for upserts, `untagResource` for removals.
 */
export const syncSchemasTags = Effect.fn(function* (
  resourceArn: string,
  id: string,
  userTags: Record<string, string> | undefined,
) {
  const internalTags = yield* createInternalTags(id);
  const desired = { ...userTags, ...internalTags };
  const observed = yield* readSchemasTags(resourceArn);
  const { upsert, removed } = diffTags(observed, desired);
  if (upsert.length > 0) {
    yield* schemas.tagResource({
      ResourceArn: resourceArn,
      Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
    });
  }
  if (removed.length > 0) {
    yield* schemas.untagResource({
      ResourceArn: resourceArn,
      TagKeys: removed,
    });
  }
});

/**
 * Canonicalizes a JSON document string for comparison: parses and re-stringifies
 * with recursively sorted object keys so semantically-equal documents compare
 * equal regardless of key order or whitespace. Non-JSON content is returned
 * verbatim.
 */
export const canonicalJson = (content: string): string => {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sortKeys(v)]),
      );
    }
    return value;
  };
  try {
    return JSON.stringify(sortKeys(JSON.parse(content)));
  } catch {
    return content;
  }
};
