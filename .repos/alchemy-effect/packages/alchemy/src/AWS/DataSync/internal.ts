import * as datasync from "@distilled.cloud/aws/datasync";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { diffTags } from "../../Tags.ts";

/**
 * A freshly-created IAM role (or a just-attached inline policy) takes a
 * while to propagate to DataSync: `CreateLocation*` transiently rejects it
 * as `LocationRoleNotAssumable` (patched from `InvalidRequestException` +
 * "Invalid IAM role") or fails its location access test as
 * `LocationAccessTestFailed` (patched from `InvalidRequestException` +
 * "location access test failed"). Bounded retry (~60s), explicitly typed so
 * declaration emit never widens the provider layer (see PATTERNS §7).
 */
export const retryWhileRoleNotAssumable = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "LocationRoleNotAssumable" ||
      e._tag === "LocationAccessTestFailed",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(20)]),
  });

/** Convert a DataSync tag list to a plain record. */
export const dsTagsToRecord = (
  tags: readonly datasync.TagListEntry[] | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [t.Key, t.Value ?? ""]));

/** Read the observed tags currently attached to a DataSync resource. */
export const readObservedTags = Effect.fn(function* (resourceArn: string) {
  const res = yield* datasync.listTagsForResource({ ResourceArn: resourceArn });
  return dsTagsToRecord(res.Tags);
});

/**
 * Diff observed cloud tags against the desired set and apply the delta.
 * DataSync `tagResource` upserts; `untagResource` removes by key.
 */
export const syncTags = Effect.fn(function* (
  resourceArn: string,
  observed: Record<string, string>,
  desired: Record<string, string>,
) {
  const { upsert, removed } = diffTags(observed, desired);
  if (upsert.length > 0) {
    yield* datasync.tagResource({
      ResourceArn: resourceArn,
      Tags: upsert.map((t) => ({ Key: t.Key, Value: t.Value })),
    });
  }
  if (removed.length > 0) {
    yield* datasync.untagResource({ ResourceArn: resourceArn, Keys: removed });
  }
});

/**
 * Scan every DataSync location and return the ARN of the one whose
 * `LocationUri` matches (ignoring a trailing slash). DataSync has no
 * create-idempotency token, so this makes reconcile idempotent across state
 * loss.
 */
export const findLocationArnByUri = Effect.fn(function* (expectedUri: string) {
  const strip = (u: string) => u.replace(/\/+$/, "");
  const target = strip(expectedUri);
  const locations = yield* datasync.listLocations.pages({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk).flatMap((p) => p.Locations ?? [])),
  );
  return locations.find(
    (l) => l.LocationUri !== undefined && strip(l.LocationUri) === target,
  )?.LocationArn;
});
