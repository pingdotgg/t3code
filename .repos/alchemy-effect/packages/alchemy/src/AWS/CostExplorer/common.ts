import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Effect from "effect/Effect";
import { diffTags } from "../../Tags.ts";
import { Region } from "../Region.ts";

// Cost Explorer is a global service served exclusively from the us-east-1
// endpoint. Every control-plane call must target that region regardless of
// the ambient stack region, so we pin it on every distilled operation. The
// distilled Region service value is `Effect<RegionName>`, not a raw string —
// providing a bare string makes the client `yield*` a string and crash
// (same pattern as CloudFront KVS / ECR Public / WAFv2 / GlobalAccelerator).
export const CE_REGION = "us-east-1" as const;

export const pinCe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Region, Effect.succeed(CE_REGION)));

/** Convert a plain tag record to Cost Explorer's `ResourceTag` list shape. */
export const toResourceTags = (
  tags: Record<string, string>,
): ce.ResourceTag[] =>
  Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

/** Convert a Cost Explorer `ResourceTag` list to a plain tag record. */
export const toTagRecord = (
  tags: readonly ce.ResourceTag[] | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [t.Key, t.Value]));

/**
 * Fetch the observed tags for a Cost Explorer resource ARN. Tolerates the
 * resource disappearing mid-read (`ResourceNotFoundException` → `{}`).
 */
export const fetchCeTags = Effect.fn(function* (resourceArn: string) {
  const listed = yield* pinCe(
    ce.listTagsForResource({ ResourceArn: resourceArn }),
  ).pipe(
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed({ ResourceTags: [] }),
    ),
  );
  return toTagRecord(listed.ResourceTags);
});

/**
 * Sync the tags on a Cost Explorer resource: diff the OBSERVED cloud tags
 * against the desired set and apply only the delta.
 */
export const syncCeTags = Effect.fn(function* (
  resourceArn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* fetchCeTags(resourceArn);
  const { upsert, removed } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* pinCe(
      ce.tagResource({ ResourceArn: resourceArn, ResourceTags: upsert }),
    );
  }
  if (removed.length > 0) {
    yield* pinCe(
      ce.untagResource({ ResourceArn: resourceArn, ResourceTagKeys: removed }),
    );
  }
});
