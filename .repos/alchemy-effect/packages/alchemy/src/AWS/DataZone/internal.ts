import * as datazone from "@distilled.cloud/aws/datazone";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { diffTags } from "../../Tags.ts";

/**
 * Unwrap a DataZone `SensitiveString` (decoded as `Redacted`) to its plain
 * string value. `String(redacted)` would yield `"<redacted>"`, not the value.
 */
export const unredact = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/**
 * Coerce a DataZone wire tag map (values may be `undefined` on the wire) into
 * a plain `Record<string, string>`.
 */
export const toTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/**
 * Sync tags on a DataZone resource by ARN: diff the OBSERVED cloud tags
 * against the desired set and apply only the delta.
 */
export const syncDataZoneTags = Effect.fn(function* (
  resourceArn: string,
  observedTags: Record<string, string>,
  desiredTags: Record<string, string>,
) {
  const { upsert, removed } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* datazone.tagResource({
      resourceArn,
      tags: Object.fromEntries(upsert.map(({ Key, Value }) => [Key, Value])),
    });
  }
  if (removed.length > 0) {
    yield* datazone.untagResource({ resourceArn, tagKeys: removed });
  }
});
