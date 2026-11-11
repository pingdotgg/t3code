import * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import * as Effect from "effect/Effect";

/**
 * Convert CloudHSM's `[{ Key, Value }]` tag list into a plain record.
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
 * Look up a single CloudHSM cluster by its cluster id. `describeClusters` is
 * a filtered list — an unknown id simply yields an empty page, so a miss is
 * `undefined` rather than a typed NotFound.
 */
export const findClusterById = Effect.fn(function* (clusterId: string) {
  const response = yield* cloudhsm.describeClusters({
    Filters: { clusterIds: [clusterId] },
  });
  return response.Clusters?.[0];
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
