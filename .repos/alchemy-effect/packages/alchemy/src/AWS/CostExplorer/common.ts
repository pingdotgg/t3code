import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { diffTags } from "../../Tags.ts";
import { Region } from "../Region.ts";

// Cost Explorer is a global service served exclusively from the us-east-1
// endpoint. Every control-plane call must target that region regardless of
// the ambient stack region, so we pin it on every distilled operation. The
// distilled Region service value is `Effect<RegionName>`, not a raw string —
// providing a bare string makes the client `yield*` a string and crash
// (same pattern as CloudFront KVS / ECR Public / WAFv2 / GlobalAccelerator).
export const CE_REGION = "us-east-1" as const;

// Cost Explorer's control-plane rate limits are extremely low and shared
// account-wide, so concurrent deploys readily trip `LimitExceededException:
// Rate limit exceeded`. Retry it with capped exponential backoff, bounded
// (~47s total) so a genuine quota LimitExceeded still surfaces quickly.
const ceThrottleRetrySchedule = Schedule.max([
  Schedule.min([
    Schedule.exponential("1 second"),
    Schedule.spaced("8 seconds"),
  ]),
  Schedule.recurs(8),
]);

export const pinCe = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.provideService(Region, Effect.succeed(CE_REGION)),
    Effect.retry({
      while: (e) => e._tag === "LimitExceededException",
      schedule: ceThrottleRetrySchedule,
    }),
  );

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
