import * as personalize from "@distilled.cloud/aws/personalize";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { diffTags } from "../../Tags.ts";

/**
 * Unwrap a Personalize `SensitiveString` (decoded as `Redacted`) to its plain
 * string value. `String(redacted)` would yield `"<redacted>"`, not the value.
 */
export const unredact = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/**
 * Coerce a Personalize wire tag list (`{ tagKey, tagValue }[]`, values decode
 * as `Redacted`) into a plain `Record<string, string>`.
 */
export const toTagRecord = (
  tags: personalize.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? []).map(
      (t) => [unredact(t.tagKey), unredact(t.tagValue)] as const,
    ),
  );

/**
 * Read the observed tags of a Personalize resource by ARN. Tag reads are
 * best-effort — a failure (e.g. a race with deletion) reports no tags.
 */
export const readPersonalizeTags = Effect.fn(function* (arn: string) {
  const response = yield* personalize
    .listTagsForResource({ resourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.tags);
});

/**
 * Sync tags on a Personalize resource: diff the OBSERVED cloud tags against
 * the desired set and apply only the delta.
 */
export const syncPersonalizeTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readPersonalizeTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* personalize.tagResource({
      resourceArn: arn,
      tags: upsert.map((t) => ({ tagKey: t.Key, tagValue: t.Value })),
    });
  }
  if (removed.length > 0) {
    // tagKeys decodes as SensitiveString — wrap in Redacted for the encoder
    // (which unwraps back to the plain string on the wire).
    yield* personalize.untagResource({
      resourceArn: arn,
      tagKeys: removed.map((key) => Redacted.make(key)),
    });
  }
});
