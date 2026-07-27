import * as memorydb from "@distilled.cloud/aws/memorydb";
import * as Effect from "effect/Effect";

/**
 * Convert MemoryDB's `[{ Key, Value }]` tag list into a plain record,
 * dropping any entry missing a key or value.
 */
export const toTagRecord = (
  tags: Array<{ Key?: string; Value?: string }> | undefined,
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
 * Read the observed tags for a MemoryDB resource by ARN. A resource that has
 * just been created (or is mid-transition) can transiently reject `listTags`;
 * treat any failure as "no observed tags" so tag reconciliation still runs.
 */
export const readMemoryDbTags = Effect.fn(function* (arn: string) {
  const response = yield* memorydb
    .listTags({ ResourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.TagList);
});

/** True when two string sets are equal ignoring order and duplicates. */
export const sameStringSet = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean => {
  const left = [...new Set(a ?? [])].sort();
  const right = [...new Set(b ?? [])].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};
