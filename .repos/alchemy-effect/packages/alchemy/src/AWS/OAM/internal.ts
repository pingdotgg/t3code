import * as oam from "@distilled.cloud/aws/oam";
import * as Retry from "@distilled.cloud/aws/Retry";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createInternalTags, diffTags } from "../../Tags.ts";

const mutationSchedule = Schedule.max([
  Schedule.spaced("1 second"),
  Schedule.recurs(20),
]);

const isRetryableOamMutationError = (
  error: unknown,
  conflict: boolean,
): boolean => {
  if (!error || typeof error !== "object") return false;
  const tag = (error as { _tag?: string })._tag;
  return (
    tag === "TooManyRequestsException" ||
    tag === "ServiceQuotaExceededException" ||
    tag === "InternalServiceFault" ||
    (conflict && tag === "ConflictException")
  );
};

/** One non-nested, bounded retry owner for OAM control-plane mutations. */
export const retryOamMutation = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: { conflict?: boolean },
): Effect.Effect<A, E, Exclude<R, Retry.Retry>> =>
  Retry.policy({
    while: (error) =>
      isRetryableOamMutationError(error, options?.conflict === true),
    schedule: mutationSchedule,
  })(effect);

class SinkLinksStillAttached extends Data.TaggedError(
  "SinkLinksStillAttached",
)<{ readonly sinkArn: string; readonly count: number }> {}

class OamResourceStillExists extends Data.TaggedError(
  "OamResourceStillExists",
)<{ readonly arn: string }> {}

const dependencySchedule = Schedule.max([
  Schedule.spaced("2 seconds"),
  Schedule.recurs(10),
]);

const goneSchedule = Schedule.max([
  Schedule.spaced("1 second"),
  Schedule.recurs(10),
]);

/**
 * Delete a sink only after attached links have drained, then observe absence.
 */
export const deleteSinkAndWait = Effect.fn(function* (sinkArn: string) {
  yield* oam.listAttachedLinks.pages({ SinkIdentifier: sinkArn }).pipe(
    Stream.runCollect,
    Effect.map((pages) =>
      Array.from(pages).reduce((count, page) => count + page.Items.length, 0),
    ),
    Effect.flatMap((count) =>
      count === 0
        ? Effect.void
        : Effect.fail(new SinkLinksStillAttached({ sinkArn, count })),
    ),
    Effect.retry({
      while: (error) => error._tag === "SinkLinksStillAttached",
      schedule: dependencySchedule,
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );

  yield* retryOamMutation(oam.deleteSink({ Identifier: sinkArn }), {
    // A just-deleted link can remain visible to DeleteSink after the list has
    // converged. Retry only this bounded dependency-violation window.
    conflict: true,
  }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));

  const observe = Retry.none(oam.getSink({ Identifier: sinkArn }));
  yield* observe.pipe(
    Effect.flatMap(() =>
      Effect.fail(new OamResourceStillExists({ arn: sinkArn })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "OamResourceStillExists" ||
        error._tag === "TooManyRequestsException",
      schedule: goneSchedule,
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );
});

/** Idempotently delete a link and observe absence before its sink can delete. */
export const deleteLinkAndWait = Effect.fn(function* (linkArn: string) {
  yield* retryOamMutation(oam.deleteLink({ Identifier: linkArn })).pipe(
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );

  const observe = Retry.none(oam.getLink({ Identifier: linkArn }));
  yield* observe.pipe(
    Effect.flatMap(() =>
      Effect.fail(new OamResourceStillExists({ arn: linkArn })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "OamResourceStillExists" ||
        error._tag === "TooManyRequestsException",
      schedule: goneSchedule,
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );
});

/**
 * Read the observed tags on an OAM sink or link, tolerating a
 * not-yet-visible resource (returns `{}`).
 */
export const readOamTags = Effect.fn(function* (resourceArn: string) {
  return yield* oam.listTagsForResource({ ResourceArn: resourceArn }).pipe(
    Effect.map((r) => (r.Tags ?? {}) as Record<string, string>),
    Effect.catchTag(["ResourceNotFoundException", "ValidationException"], () =>
      Effect.succeed({} as Record<string, string>),
    ),
  );
});

/**
 * Converge the tags on an OAM sink or link to the desired user tags merged
 * with the internal Alchemy ownership tags, diffing against OBSERVED cloud
 * tags so adoption converges.
 */
export const syncOamTags = Effect.fn(function* (
  resourceArn: string,
  id: string,
  userTags: Record<string, string> | undefined,
) {
  const internalTags = yield* createInternalTags(id);
  const desired = { ...(userTags ?? {}), ...internalTags };
  const observed = yield* readOamTags(resourceArn);
  const { upsert, removed } = diffTags(observed, desired);
  if (upsert.length > 0) {
    yield* retryOamMutation(
      oam.tagResource({
        ResourceArn: resourceArn,
        Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
      }),
    );
  }
  if (removed.length > 0) {
    yield* retryOamMutation(
      oam.untagResource({ ResourceArn: resourceArn, TagKeys: removed }),
    );
  }
});
