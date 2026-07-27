import * as grafana from "@distilled.cloud/aws/grafana";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { diffTags } from "../../Tags.ts";

/** Unwrap a possibly-redacted string field returned by the Grafana API. */
export const unredact = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

/**
 * Coerce a Grafana wire tag map (values are `string | undefined`) into a
 * plain `Record<string, string>`.
 */
export const toTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

/** Read the observed tags of a Grafana resource by ARN (best-effort). */
export const readGrafanaTags = Effect.fn(function* (arn: string) {
  const response = yield* grafana
    .listTagsForResource({ resourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.tags);
});

/**
 * Sync tags on a Grafana resource: diff OBSERVED cloud tags against the
 * desired set and apply only the delta. Grafana's `tagResource` takes a tag
 * map, so the `upsert` delta is folded back into a record.
 */
export const syncGrafanaTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readGrafanaTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* grafana.tagResource({
      resourceArn: arn,
      tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
    });
  }
  if (removed.length > 0) {
    yield* grafana.untagResource({ resourceArn: arn, tagKeys: removed });
  }
});
