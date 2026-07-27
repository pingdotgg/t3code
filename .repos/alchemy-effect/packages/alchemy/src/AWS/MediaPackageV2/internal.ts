import * as mediapackagev2 from "@distilled.cloud/aws/mediapackagev2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { diffTags } from "../../Tags.ts";

/**
 * Coerce a MediaPackage wire tag map (values are `string | undefined`) into a
 * plain `Record<string, string>`, dropping any undefined values.
 */
export const toMpTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

/**
 * Sync tags on a MediaPackage resource: diff the OBSERVED cloud tags against
 * the desired set and apply only the delta.
 */
export const syncMpTags = Effect.fn(function* (
  arn: string,
  observedTags: Record<string, string>,
  desiredTags: Record<string, string>,
) {
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* mediapackagev2.tagResource({
      ResourceArn: arn,
      Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
    });
  }
  if (removed.length > 0) {
    yield* mediapackagev2.untagResource({
      ResourceArn: arn,
      TagKeys: removed,
    });
  }
});

/**
 * Explicitly-typed pipeable retry helper. Inlining `Effect.retry` in a
 * provider lifecycle op leaks `Retry.Return`'s conditional into declaration
 * emit and widens the provider layer to `unknown` R for every consumer of
 * `AWS.providers()`.
 *
 * MediaPackage rejects deleting a parent whose children are still being
 * cleaned up (and concurrent mutations of the same resource) with
 * `ConflictException`; both settle within seconds.
 */
export const retryWhileMpConflict = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(15)]),
  });

/**
 * Enumerate every channel group in the account/region.
 */
export const listAllChannelGroups = Effect.fn(function* () {
  return yield* mediapackagev2.listChannelGroups.pages({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).flatMap((page) => page.Items ?? []),
    ),
  );
});

/**
 * Enumerate every channel in a channel group; a missing group yields `[]`
 * (the typed not-found), so callers can race against a concurrent delete.
 */
export const listGroupChannels = Effect.fn(function* (
  channelGroupName: string,
) {
  return yield* mediapackagev2.listChannels
    .pages({ ChannelGroupName: channelGroupName })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).flatMap((page) => page.Items ?? []),
      ),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed([] as mediapackagev2.ChannelListConfiguration[]),
      ),
    );
});

/**
 * Enumerate every origin endpoint in a channel; a missing channel/group
 * yields `[]` (the typed not-found).
 */
export const listChannelEndpoints = Effect.fn(function* (
  channelGroupName: string,
  channelName: string,
) {
  return yield* mediapackagev2.listOriginEndpoints
    .pages({ ChannelGroupName: channelGroupName, ChannelName: channelName })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).flatMap((page) => page.Items ?? []),
      ),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed([] as mediapackagev2.OriginEndpointListConfiguration[]),
      ),
    );
});

/**
 * Delete a channel after reaping its origin endpoints. MediaPackage refuses
 * to delete a channel that still has endpoints, so an orphan sweep that
 * targets a channel without enumerating its children would Conflict until
 * the retry budget ran out and leak the channel. A normal stack destroy
 * deletes the endpoints first, so the reap observes nothing and is free.
 * Every step is idempotent (deleting a missing endpoint/channel succeeds).
 */
export const deleteChannelWithEndpoints = Effect.fn(function* (
  channelGroupName: string,
  channelName: string,
) {
  const endpoints = yield* listChannelEndpoints(channelGroupName, channelName);
  yield* Effect.forEach(
    endpoints,
    (endpoint) =>
      mediapackagev2.deleteOriginEndpoint({
        ChannelGroupName: channelGroupName,
        ChannelName: channelName,
        OriginEndpointName: endpoint.OriginEndpointName,
      }),
    { concurrency: 5, discard: true },
  );
  // The channel transiently rejects deletion with a Conflict while its
  // just-deleted endpoints are cleaned up.
  yield* mediapackagev2
    .deleteChannel({
      ChannelGroupName: channelGroupName,
      ChannelName: channelName,
    })
    .pipe(retryWhileMpConflict);
});

/**
 * Compare two IAM policy documents for semantic equality: parse both as JSON
 * and compare the normalized serialization, so whitespace/key-order changes
 * introduced by AWS never register as drift. Falls back to strict string
 * equality when either side is not valid JSON.
 */
export const policiesEqual = (
  a: string | undefined,
  b: string | undefined,
): boolean => {
  if (a === undefined || b === undefined) return a === b;
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return a === b;
  }
};

/**
 * Structural "desired is a subset of observed" comparison used for drift
 * detection. Only keys present (and defined) in `desired` are compared, so
 * server-side defaults on the observed state never register as drift. Arrays
 * must match pairwise and in length so removed/added items are detected.
 */
export const matchesDesired = (
  desired: unknown,
  observed: unknown,
): boolean => {
  if (desired === undefined) return true;
  if (desired === null) return observed === null;
  if (desired instanceof Date) {
    return observed instanceof Date && desired.getTime() === observed.getTime();
  }
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed) || observed.length !== desired.length) {
      return false;
    }
    return desired.every((item, i) => matchesDesired(item, observed[i]));
  }
  if (typeof desired === "object") {
    if (
      typeof observed !== "object" ||
      observed === null ||
      Array.isArray(observed)
    ) {
      return false;
    }
    return Object.entries(desired as Record<string, unknown>).every(
      ([key, value]) =>
        value === undefined
          ? true
          : matchesDesired(value, (observed as Record<string, unknown>)[key]),
    );
  }
  return desired === observed;
};
