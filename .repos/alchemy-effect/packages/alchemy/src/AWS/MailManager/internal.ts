import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { diffTags, tagRecord } from "../../Tags.ts";

/**
 * Read the observed tags for any Mail Manager resource ARN. Tag reads are
 * best-effort — a race with deletion (or a missing-tags edge) degrades to an
 * empty record rather than failing the lifecycle operation.
 */
export const readMailManagerTags = (arn: string) =>
  mm.listTagsForResource({ ResourceArn: arn }).pipe(
    Effect.map((r) => tagRecord(r.Tags ?? [])),
    Effect.catch(() => Effect.succeed<Record<string, string>>({})),
  );

/**
 * Converge the tags on a Mail Manager resource to `desired`, diffing against
 * the OBSERVED cloud tags so adoption converges.
 */
export const syncMailManagerTags = Effect.fn(function* (
  arn: string,
  desired: Record<string, string>,
) {
  const current = yield* readMailManagerTags(arn);
  const { upsert, removed } = diffTags(current, desired);
  if (upsert.length > 0) {
    yield* mm.tagResource({ ResourceArn: arn, Tags: upsert });
  }
  if (removed.length > 0) {
    yield* mm.untagResource({ ResourceArn: arn, TagKeys: removed });
  }
});

/**
 * Retry an operation while Mail Manager reports a ConflictException — e.g.
 * deleting an ingress point that is still PROVISIONING. Explicitly typed so
 * `Retry.Return`'s conditional type never leaks into declaration emit.
 */
export const retryWhileMailManagerConflict = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(10)]),
  });

/**
 * Repeat a poll until `done` holds (bounded). Explicitly typed for the same
 * declaration-emit reason as above.
 */
export const repeatUntilMailManagerStable = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  done: (a: A) => boolean,
  times = 24,
): Effect.Effect<A, E, R> =>
  Effect.repeat(self, {
    schedule: Schedule.spaced("5 seconds"),
    until: done,
    times,
  });

/**
 * Deep structural equality on JSON-ish values with key order and
 * `undefined`-valued members normalized away. Used to compare desired config
 * structs (rules, policy statements, authentication) against observed cloud
 * state.
 */
const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([l], [r]) => l.localeCompare(r))
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
};

export const sameShape = (l: unknown, r: unknown) =>
  JSON.stringify(normalize(l)) === JSON.stringify(normalize(r));
