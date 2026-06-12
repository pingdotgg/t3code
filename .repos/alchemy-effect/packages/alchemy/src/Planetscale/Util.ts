import * as ops from "@distilled.cloud/planetscale/Operations";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { ScopedPlanStatusSession } from "../Cli/Cli.ts";

export const DEFAULT_MIGRATIONS_TABLE = "__alchemy_migrations";

/**
 * Tagged error raised when polling for a state predicate that has not yet
 * been reached. Used internally with `Effect.retry` to drive long-running
 * status waits.
 */
class NotReady extends Data.TaggedError("Planetscale::NotReady")<{
  description: string;
}> {}

/**
 * Tagged error raised by reconcilers when an immutable property of a live
 * PlanetScale resource does not match the desired configuration (e.g.
 * region, kind, parent_branch). User-recoverable: change the config to
 * match, or replace/delete the existing resource and retry.
 */
export class PlanetscaleConflict extends Data.TaggedError(
  "Planetscale::Conflict",
)<{
  message: string;
}> {}

/**
 * Default polling schedule: 5s spaced retries with a 10-minute total
 * budget (120 × 5s). Avoids the exponential-blowup trap where later
 * iterations would wait hours, indistinguishable from a hang.
 */
const defaultSchedule = Schedule.spaced("5 seconds").pipe(
  Schedule.both(Schedule.recurs(120)),
);

/**
 * Generic polling helper that retries until `predicate(value)` returns true
 * (or until the schedule is exhausted). Engine-specific helpers (e.g.
 * `waitForKeyspaceReady`, `waitForPendingPostgresChanges`) are built on top
 * of this primitive.
 */
export const pollUntil = <A, E, R>(
  description: string,
  fn: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean,
  schedule: Schedule.Schedule<unknown, unknown, never> = defaultSchedule,
): Effect.Effect<A, E, R> =>
  fn.pipe(
    Effect.flatMap((value) =>
      predicate(value)
        ? Effect.succeed(value)
        : Effect.fail(new NotReady({ description })),
    ),
    Effect.retry({
      while: (e: any) => e?._tag === "Planetscale::NotReady",
      schedule,
    }),
  ) as Effect.Effect<A, E, R>;

/**
 * Polls a branch via `getBranch` until it reports `ready === true`. Returns
 * the final branch shape. `NotFound` during polling is treated as
 * not-yet-ready (the branch is being provisioned by an upstream operation).
 *
 * If a `session` is supplied, each poll emits a note with elapsed seconds and
 * expectation-setting so the CLI surfaces progress while we sit in the spaced
 * retry loop.
 */
export const waitForBranchReady = Effect.fn(function* (
  organization: string,
  database: string,
  branch: string,
  session?: ScopedPlanStatusSession,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  return yield* pollUntil(
    `branch "${branch}" ready`,
    Effect.gen(function* () {
      if (session) {
        const now = yield* Clock.currentTimeMillis;
        const seconds = Math.floor((now - startedAt) / 1000);
        yield* session.note(
          `Waiting for branch to be ready... (${seconds} seconds elapsed; this can take a few minutes)`,
        );
      }
      return yield* ops.getBranch({ organization, database, branch });
    }).pipe(
      Effect.catchTag("NotFound", () =>
        Effect.fail(
          new NotReady({ description: `branch "${branch}" not found yet` }),
        ),
      ),
    ),
    (data) => data.ready,
  );
});

/**
 * Polls a database via `getDatabase` until it reports `ready === true`.
 * `NotFound` during polling is treated as not-yet-ready (the database is
 * being provisioned by an upstream operation).
 *
 * If a `session` is supplied, each poll emits a note with elapsed seconds and
 * expectation-setting so the CLI surfaces progress while we sit in the spaced
 * retry loop.
 */
export const waitForDatabaseReady = Effect.fn(function* (
  organization: string,
  database: string,
  session?: ScopedPlanStatusSession,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  return yield* pollUntil(
    `database "${database}" ready`,
    Effect.gen(function* () {
      if (session) {
        const now = yield* Clock.currentTimeMillis;
        const seconds = Math.floor((now - startedAt) / 1000);
        yield* session.note(
          `Waiting for database to be ready... (${seconds} seconds elapsed; this can take a few minutes)`,
        );
      }
      return yield* ops.getDatabase({ organization, database });
    }).pipe(
      Effect.catchTag("NotFound", () =>
        Effect.fail(
          new NotReady({
            description: `database "${database}" not found yet`,
          }),
        ),
      ),
    ),
    (data) => data.ready,
  );
});

export const isKnownError =
  (tag: string, message: string) => (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    (error as { readonly _tag?: unknown })._tag === tag &&
    (error as { readonly message?: unknown }).message === message;

// todo: this repeats across Neon, D1, and PlanetScale resources so maybe we should move it to Diff? or Util?
export const recordsEqual = (
  a: Record<string, string>,
  b: Record<string, string>,
): boolean => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
};
