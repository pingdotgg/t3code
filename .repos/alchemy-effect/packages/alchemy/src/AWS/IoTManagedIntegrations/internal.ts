import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { diffTags } from "../../Tags.ts";

/**
 * Unwrap a distilled `SensitiveString` (`string | Redacted<string>`) into a
 * plain string, preserving `undefined`.
 */
export const unwrapSensitive = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

/**
 * Convert the wire `TagsMap` (`Record<string, string | undefined>`) into a
 * plain `Record<string, string>`, dropping entries without a value.
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
 * Reconcile the tags on an IoT Managed Integrations resource identified by
 * ARN: diff OBSERVED cloud tags against the desired set and apply only the
 * delta via tagResource/untagResource.
 */
export const syncManagedIntegrationsTags = Effect.fn(function* (
  resourceArn: string,
  observedTags: Record<string, string>,
  desiredTags: Record<string, string>,
) {
  const { upsert, removed } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* mi.tagResource({
      ResourceArn: resourceArn,
      Tags: Object.fromEntries(upsert.map((tag) => [tag.Key, tag.Value])),
    });
  }
  if (removed.length > 0) {
    yield* mi.untagResource({ ResourceArn: resourceArn, TagKeys: removed });
  }
});
