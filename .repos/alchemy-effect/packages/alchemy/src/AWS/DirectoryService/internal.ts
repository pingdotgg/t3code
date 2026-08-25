import * as ds from "@distilled.cloud/aws/directory-service";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Convert Directory Service's `[{ Key, Value }]` tag list into a plain
 * record, dropping any entry missing a key or value.
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
 * Read the observed tags for a directory by id. A directory mid-transition
 * (or already deleted out of band) can reject `listTagsForResource`; treat
 * any failure as "no observed tags" so tag reconciliation still converges on
 * the next pass.
 */
export const readDirectoryTags = Effect.fn(function* (directoryId: string) {
  const tags = yield* ds.listTagsForResource
    .items({ ResourceId: directoryId })
    .pipe(
      Stream.runCollect,
      Effect.catch(() => Effect.succeed([] as ds.Tag[])),
    );
  return toTagRecord(Array.from(tags));
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
