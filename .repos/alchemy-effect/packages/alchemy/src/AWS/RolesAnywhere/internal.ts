import * as rolesanywhere from "@distilled.cloud/aws/rolesanywhere";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { diffTags } from "../../Tags.ts";

const unwrap = (v: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(v) ? Redacted.value(v) : v;

/**
 * Convert a RolesAnywhere wire tag list (`{ key, value }[]`, values possibly
 * decoded as `Redacted`) into a plain record.
 */
export const toTagRecord = (
  tags: ReadonlyArray<rolesanywhere.Tag> | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [unwrap(t.key), unwrap(t.value)]));

/**
 * Convert a desired tag record into the RolesAnywhere wire tag list for
 * create/import calls.
 */
export const toWireTags = (tags: Record<string, string>): rolesanywhere.Tag[] =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));

/**
 * Read the observed tags of a RolesAnywhere resource. Tag reads are
 * best-effort — a failure (e.g. a race with deletion) reports no tags.
 */
export const readRolesAnywhereTags = Effect.fn(function* (arn: string) {
  const response = yield* rolesanywhere
    .listTagsForResource({ resourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.tags);
});

/**
 * Sync tags on a RolesAnywhere resource: diff the OBSERVED cloud tags against
 * the desired set and apply only the delta.
 */
export const syncRolesAnywhereTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readRolesAnywhereTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* rolesanywhere.tagResource({
      resourceArn: arn,
      tags: upsert.map(({ Key, Value }) => ({ key: Key, value: Value })),
    });
  }
  if (removed.length > 0) {
    yield* rolesanywhere.untagResource({ resourceArn: arn, tagKeys: removed });
  }
});
