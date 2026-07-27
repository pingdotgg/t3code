import * as appsync from "@distilled.cloud/aws/appsync";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Schedule from "effect/Schedule";
import { diffTags, normalizeTags } from "../../Tags.ts";

/**
 * AppSync serializes control-plane mutations per API; concurrent resolver /
 * data-source / schema operations surface as `ConcurrentModificationException`.
 * Ride out the contention window with a bounded retry (~40s).
 *
 * The helper carries an EXPLICIT return annotation so the conditional type
 * of `Effect.retry` never leaks into declaration emit (which would widen the
 * provider layer to `unknown` for every consumer of `AWS.providers()`).
 */
export const retryConcurrentModification = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(effect, {
    while: (error: E) => error._tag === "ConcurrentModificationException",
    schedule: Schedule.max([
      pipe(
        Schedule.exponential(Duration.seconds(1), 2),
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(
            Duration.isGreaterThan(duration, Duration.seconds(8))
              ? Duration.seconds(8)
              : duration,
          ),
        ),
      ),
      Schedule.recurs(8),
    ]),
  }) as Effect.Effect<A, E, R>;

/**
 * IAM changes (fresh service roles, updated trust policies) propagate to
 * AppSync eventually; a `createDataSource` right after `createRole` can
 * transiently fail with a `BadRequestException` complaining that AppSync
 * is not authorized to assume the role. Bounded retry (~20s), scoped to
 * role-assumption messages so genuine validation errors fail fast.
 */
export const retryWhileRolePropagates = <
  A,
  E extends { _tag: string; message?: string },
  R,
>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(effect, {
    while: (error: E) =>
      error._tag === "BadRequestException" &&
      /assume|role|authorized/i.test(error.message ?? ""),
    schedule: Schedule.max([
      Schedule.fixed(Duration.seconds(2)),
      Schedule.recurs(10),
    ]),
  }) as Effect.Effect<A, E, R>;

/**
 * AppSync data-source and pipeline-function names must match
 * `[_A-Za-z][_0-9A-Za-z]*` (no dashes). Deterministic physical names are
 * generated with dashes, so sanitize into the allowed alphabet.
 */
export const sanitizeAppSyncName = (name: string): string => {
  const sanitized = name.replaceAll(/[^_0-9A-Za-z]/g, "_");
  return /^[_A-Za-z]/.test(sanitized) ? sanitized : `_${sanitized}`;
};

/**
 * Normalize the wire tag map (values may be `undefined`) to a plain record.
 */
export const tagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/**
 * Diff observed tags against desired tags and apply only the delta via the
 * AppSync `tagResource`/`untagResource` operations.
 */
export const syncAppSyncTags = Effect.fn(function* ({
  resourceArn,
  oldTags,
  newTags,
}: {
  resourceArn: string;
  oldTags: Record<string, string>;
  newTags: Record<string, string>;
}) {
  const { removed, upsert } = diffTags(oldTags, newTags);
  if (removed.length > 0) {
    yield* appsync
      .untagResource({ resourceArn, tagKeys: removed })
      .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
  }
  if (upsert.length > 0) {
    yield* appsync.tagResource({
      resourceArn,
      tags: normalizeTags(upsert),
    });
  }
});
