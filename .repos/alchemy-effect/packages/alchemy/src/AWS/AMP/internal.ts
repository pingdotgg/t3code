import * as amp from "@distilled.cloud/aws/amp";
import * as Effect from "effect/Effect";
import { diffTags } from "../../Tags.ts";

/**
 * Coerce an AMP wire tag map (values are `string | undefined`) into a plain
 * `Record<string, string>`, dropping undefined values.
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
 * Read the observed tags of an AMP resource by ARN. Tag reads are
 * best-effort — a failure (e.g. a race with deletion) reports no tags.
 */
export const readAmpTags = Effect.fn(function* (arn: string) {
  const response = yield* amp
    .listTagsForResource({ resourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.tags);
});

/**
 * Sync tags on an AMP resource: diff the OBSERVED cloud tags against the
 * desired set and apply only the delta. AMP's `tagResource` takes a tag
 * map (not a list), so the `upsert` delta is folded back into a record.
 */
export const syncAmpTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readAmpTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* amp.tagResource({
      resourceArn: arn,
      tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
    });
  }
  if (removed.length > 0) {
    yield* amp.untagResource({ resourceArn: arn, tagKeys: removed });
  }
});

/**
 * AMP's logging APIs expect the destination CloudWatch Logs log group ARN
 * with a trailing `:*` (the log-stream wildcard). Append it when missing so
 * callers can pass a `Logs.LogGroup`'s `logGroupArn` directly.
 */
export const normalizeAmpLogGroupArn = (arn: string): string =>
  arn.endsWith(":*") ? arn : `${arn}:*`;

/** Encode a UTF-8 string definition into the wire blob AMP expects. */
export const encodeDefinition = (
  definition: string,
): Effect.Effect<Uint8Array> =>
  Effect.sync(() => new TextEncoder().encode(definition));

/** Decode an AMP definition blob back into a UTF-8 string. */
export const decodeDefinition = (data: Uint8Array): Effect.Effect<string> =>
  Effect.sync(() => new TextDecoder().decode(data));
