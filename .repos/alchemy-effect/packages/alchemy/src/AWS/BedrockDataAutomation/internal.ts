import * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { diffTags } from "../../Tags.ts";

/**
 * Unwrap a Bedrock Data Automation `SensitiveString` (decoded as `Redacted`)
 * to its plain string value. `String(redacted)` would yield `"<redacted>"`,
 * not the value.
 */
export const unredact = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/**
 * Coerce a Bedrock Data Automation wire tag list (`{ key, value }[]`) into a
 * plain `Record<string, string>`.
 */
export const toBdaTagRecord = (
  tags: bda.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [t.key, t.value] as const));

/**
 * Coerce a plain tag record into the Bedrock Data Automation wire tag list
 * (`{ key, value }[]`).
 */
export const toBdaTagList = (tags: Record<string, string>): bda.Tag[] =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));

/**
 * Read the observed tags of a Bedrock Data Automation resource by ARN. A
 * missing resource (race with deletion) reports no tags.
 */
export const readBdaTags = Effect.fn(function* (resourceARN: string) {
  const response = yield* bda
    .listTagsForResource({ resourceARN })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  return toBdaTagRecord(response?.tags);
});

/**
 * Sync tags on a Bedrock Data Automation resource: diff the OBSERVED cloud
 * tags against the desired set and apply only the delta.
 */
export const syncBdaTags = Effect.fn(function* (
  resourceARN: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readBdaTags(resourceARN);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* bda.tagResource({
      resourceARN,
      tags: upsert.map(({ Key, Value }) => ({ key: Key, value: Value })),
    });
  }
  if (removed.length > 0) {
    yield* bda.untagResource({ resourceARN, tagKeys: removed });
  }
});

/**
 * Key-order-independent structural equality for configuration objects, used
 * to diff observed cloud configuration against the desired props. The server
 * may fill defaulted fields the user never specified — a mismatch then just
 * re-applies the idempotent PUT.
 */
export const bdaConfigEquals = (a: unknown, b: unknown): boolean =>
  stableStringify(a) === stableStringify(b);

const stableStringify = (value: unknown): string =>
  JSON.stringify(sortKeysDeep(value));

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([l], [r]) => l.localeCompare(r))
        .map(([k, v]) => [k, sortKeysDeep(v)] as const),
    );
  }
  return value;
};
