import type * as s3files from "@distilled.cloud/aws/s3files";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Raised when an S3 Files file system or access point fails to settle into
 * `available` within the bounded polling budget, or when the API returns a
 * structurally incomplete description.
 */
export class S3FilesNotConverged extends Data.TaggedError(
  "S3FilesNotConverged",
)<{
  readonly resource: string;
  readonly status: string | undefined;
}> {}

/**
 * Bounded retry through transient `ConflictException` states — e.g. deleting
 * a file system or access point whose previous lifecycle transition is still
 * settling.
 *
 * Expressed as an explicitly-typed module-scope helper: inlining
 * `Effect.retry` in lifecycle code leaves its conditional return type
 * unresolved in the provider's declaration emit, which widens the
 * `AWS.providers()` layer type for every downstream consumer.
 */
export const retryWhileConflict = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
  });

/**
 * Repeat an observe poll until `done` holds (bounded — file systems and
 * access points typically become `available` within seconds). Explicitly
 * typed for the declaration-emit reason above.
 */
export const untilSettled = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  done: (a: A) => boolean,
): Effect.Effect<A, E, R> =>
  Effect.repeat(self, {
    schedule: Schedule.spaced("3 seconds"),
    until: done,
    times: 30,
  });

/**
 * Convert the wire tag list (`[{ key, value }]`) into a plain record for
 * diffing with `diffTags`.
 */
export const toTagRecord = (
  tags: readonly s3files.Tag[] | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const tag of tags ?? []) {
    out[tag.key] = tag.value;
  }
  return out;
};

/**
 * Convert a plain tag record into the wire tag list shape.
 */
export const toTagList = (tags: Record<string, string>): s3files.Tag[] =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));
