import * as securitylake from "@distilled.cloud/aws/securitylake";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Security Lake tags use lowercase `{ key, value }` wire members (unlike most
 * AWS services' `{ Key, Value }`), so the generic Tags.ts converters don't
 * apply directly.
 */
export const toTagList = (tags: Record<string, string>): securitylake.Tag[] =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));

export const fromTagList = (
  tags: readonly securitylake.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((tag) => [tag.key, tag.value]));

/** Observed cloud tags for a Security Lake resource ARN ({} on any failure). */
export const readSecurityLakeTags = (resourceArn: string) =>
  securitylake.listTagsForResource({ resourceArn }).pipe(
    Effect.map((response) => fromTagList(response.tags)),
    Effect.catch(() => Effect.succeed<Record<string, string>>({})),
  );

/**
 * Bounded retry through transient `ConflictException`s (e.g. a subscriber or
 * data-lake mutation racing an in-flight update). Explicitly annotated so the
 * `Retry.Return` conditional never leaks into declaration emit.
 */
export const retryWhileConflict = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (error) => error._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(8)]),
  });
