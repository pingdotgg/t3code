import * as appflow from "@distilled.cloud/aws/appflow";
import * as Effect from "effect/Effect";
import { diffTags } from "../../Tags.ts";

/**
 * Coerce an AppFlow wire tag map (`Record<string, string | undefined>`) into
 * a plain `Record<string, string>`, dropping undefined values.
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
 * Read the observed tags of an AppFlow resource. Tag reads are best-effort.
 */
export const readAppFlowTags = Effect.fn(function* (arn: string) {
  const response = yield* appflow
    .listTagsForResource({ resourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.tags);
});

/**
 * Sync tags on an AppFlow resource: diff the OBSERVED cloud tags against the
 * desired set and apply only the delta.
 */
export const syncAppFlowTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readAppFlowTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* appflow.tagResource({
      resourceArn: arn,
      tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
    });
  }
  if (removed.length > 0) {
    yield* appflow.untagResource({ resourceArn: arn, tagKeys: removed });
  }
});
