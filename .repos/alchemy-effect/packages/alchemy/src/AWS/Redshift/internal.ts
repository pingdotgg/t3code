import * as redshift from "@distilled.cloud/aws/redshift";
import * as Effect from "effect/Effect";

/**
 * Convert Redshift's `[{ Key, Value }]` tag list into a plain record,
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

/** True when two string sets are equal ignoring order and duplicates. */
export const sameStringSet = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean => {
  const left = [...new Set(a ?? [])].sort();
  const right = [...new Set(b ?? [])].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

/**
 * Build the ARN of a provisioned-Redshift resource. Redshift describe
 * responses do not surface resource ARNs (only the namespace ARN on
 * clusters), so tag operations construct them from the ambient
 * account/region.
 */
export const redshiftArn = (
  region: string,
  accountId: string,
  resourceType:
    | "cluster"
    | "subnetgroup"
    | "parametergroup"
    | "eventsubscription",
  name: string,
): string => `arn:aws:redshift:${region}:${accountId}:${resourceType}:${name}`;

/**
 * Apply a tag delta to a provisioned-Redshift resource via the shared
 * CreateTags/DeleteTags operations. `upsert`/`removed` come from `diffTags`
 * against OBSERVED cloud tags (Redshift describe responses carry tags
 * inline).
 */
export const applyRedshiftTagDelta = Effect.fn(function* (input: {
  arn: string;
  upsert: Array<{ Key: string; Value: string }>;
  removed: string[];
}) {
  if (input.upsert.length > 0) {
    yield* redshift.createTags({
      ResourceName: input.arn,
      Tags: input.upsert,
    });
  }
  if (input.removed.length > 0) {
    yield* redshift.deleteTags({
      ResourceName: input.arn,
      TagKeys: input.removed,
    });
  }
});
