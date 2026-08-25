import * as mq from "@distilled.cloud/aws/mq";
import * as Effect from "effect/Effect";
import { diffTags } from "../../Tags.ts";

/**
 * Amazon MQ tags are a plain string map on the wire. Drop any `undefined`
 * values (the distilled map type is `{ [k: string]: string | undefined }`)
 * so downstream diffing works on a clean `Record<string, string>`.
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
 * Sync tags on an Amazon MQ resource (broker or configuration): diff the
 * OBSERVED cloud tags against the desired set and apply only the delta via
 * `createTags` (upsert) / `deleteTags` (remove).
 */
export const syncMqTags = Effect.fn(function* (
  arn: string,
  observedTags: Record<string, string>,
  desiredTags: Record<string, string>,
) {
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* mq.createTags({
      ResourceArn: arn,
      Tags: Object.fromEntries(upsert.map(({ Key, Value }) => [Key, Value])),
    });
  }
  if (removed.length > 0) {
    yield* mq.deleteTags({ ResourceArn: arn, TagKeys: removed });
  }
});
