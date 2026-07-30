import * as notifications from "@distilled.cloud/aws/notifications";
import * as Effect from "effect/Effect";
import { createInternalTags, diffTags } from "../../Tags.ts";
import { Region } from "../Region.ts";

/**
 * AWS User Notifications is managed from a single control-plane region.
 * Every management API call must target `us-east-1` regardless of the
 * ambient stack region (other regions reject with "API ...Activity cannot
 * be called in us-west-2. Use us-east-1 instead"), so we pin the region on
 * every distilled operation.
 */
const US_EAST_1 = "us-east-1";
export const pinNotificationsRegion = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.provideService(Region, Effect.succeed(US_EAST_1)));

/**
 * Read the observed tags on a User Notifications resource, tolerating a
 * not-yet-visible resource (returns `{}`).
 */
export const readNotificationsTags = Effect.fn(function* (arn: string) {
  return yield* pinNotificationsRegion(
    notifications.listTagsForResource({ arn }).pipe(
      Effect.map((r) => (r.tags ?? {}) as Record<string, string>),
      Effect.catchTag(
        ["ResourceNotFoundException", "ValidationException"],
        () => Effect.succeed({} as Record<string, string>),
      ),
    ),
  );
});

/**
 * Converge the tags on a User Notifications resource to the desired user
 * tags merged with the internal Alchemy ownership tags, diffing against
 * OBSERVED cloud tags so adoption converges.
 */
export const syncNotificationsTags = Effect.fn(function* (
  arn: string,
  id: string,
  userTags: Record<string, string> | undefined,
) {
  const internalTags = yield* createInternalTags(id);
  const desired = { ...userTags, ...internalTags };
  const observed = yield* readNotificationsTags(arn);
  const { upsert, removed } = diffTags(observed, desired);
  if (upsert.length > 0) {
    yield* pinNotificationsRegion(
      notifications.tagResource({
        arn,
        tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
      }),
    );
  }
  if (removed.length > 0) {
    yield* pinNotificationsRegion(
      notifications.untagResource({ arn, tagKeys: removed }),
    );
  }
});
