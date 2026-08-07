import * as entityresolution from "@distilled.cloud/aws/entityresolution";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { diffTags } from "../../Tags.ts";

/**
 * Coerce an Entity Resolution wire tag map (values decode as
 * `string | undefined`) into a plain `Record<string, string>`.
 */
export const toTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

/**
 * Read the observed tags of an Entity Resolution resource by ARN. The
 * `Get*` operations do NOT return tags even when they exist, so ownership
 * checks must go through `listTagsForResource`. Tag reads are best-effort —
 * a failure (e.g. a race with deletion) reports no tags.
 */
export const readEntityResolutionTags = Effect.fn(function* (arn: string) {
  const response = yield* entityresolution
    .listTagsForResource({ resourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.tags);
});

/**
 * Sync tags on an Entity Resolution resource: diff the OBSERVED cloud tags
 * against the desired set and apply only the delta.
 */
export const syncEntityResolutionTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readEntityResolutionTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* entityresolution.tagResource({
      resourceArn: arn,
      tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
    });
  }
  if (removed.length > 0) {
    yield* entityresolution.untagResource({
      resourceArn: arn,
      tagKeys: removed,
    });
  }
});

/**
 * Retry the IAM-propagation race on workflow create/update: a freshly created
 * role is transiently rejected until IAM propagates. The race surfaces as
 * `AccessDeniedException` with either `Exception in assuming the passed
 * role ...` (the role itself hasn't propagated) or `The service does not
 * have access to read your data in Glue/S3 ...` (the role resolved but its
 * just-attached policy hasn't). Bounded; explicitly typed as a pipeable
 * helper so declaration emit stays clean (inlining `Effect.retry` erases
 * `E`/`R` to `unknown` for every consumer).
 */
export const retryRolePropagation = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e instanceof entityresolution.AccessDeniedException &&
      typeof e.message === "string" &&
      (e.message.includes("assuming the passed role") ||
        e.message.includes("does not have access")),
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(20)]),
  });
