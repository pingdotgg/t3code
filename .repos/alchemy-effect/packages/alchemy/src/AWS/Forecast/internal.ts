import * as forecast from "@distilled.cloud/aws/forecast";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { diffTags } from "../../Tags.ts";

/**
 * Unwrap a Forecast `SensitiveString` (decoded as `Redacted`) to its plain
 * string value. `String(redacted)` would yield `"<redacted>"`, not the value.
 */
export const unredact = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/**
 * Coerce a Forecast wire tag list (`{ Key, Value }[]`, values decode as
 * `Redacted`) into a plain `Record<string, string>`.
 */
export const toTagRecord = (
  tags: forecast.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? []).map((t) => [unredact(t.Key), unredact(t.Value)] as const),
  );

/**
 * Read the observed tags of a Forecast resource by ARN. Tag reads are
 * best-effort — a failure (e.g. a race with deletion) reports no tags.
 */
export const readForecastTags = Effect.fn(function* (arn: string) {
  const response = yield* forecast
    .listTagsForResource({ ResourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.Tags);
});

/**
 * Sync tags on a Forecast resource: diff the OBSERVED cloud tags against the
 * desired set and apply only the delta.
 */
export const syncForecastTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readForecastTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* forecast.tagResource({
      ResourceArn: arn,
      Tags: upsert.map((t) => ({ Key: t.Key, Value: t.Value })),
    });
  }
  if (removed.length > 0) {
    // TagKeys decodes as SensitiveString — wrap in Redacted for the encoder
    // (which unwraps back to the plain string on the wire).
    yield* forecast.untagResource({
      ResourceArn: arn,
      TagKeys: removed.map((key) => Redacted.make(key)),
    });
  }
});

/**
 * Coerce a generated physical name into Forecast's identifier constraint
 * (`^[a-zA-Z][a-zA-Z0-9_]*` — underscores only, must start with a letter).
 * `createPhysicalName` emits DNS-style hyphens, which Forecast rejects.
 */
export const toForecastName = (name: string) => {
  const sanitized = name.replaceAll(/[^a-zA-Z0-9_]/g, "_");
  return /^[a-zA-Z]/.test(sanitized) ? sanitized : `f${sanitized.slice(0, 62)}`;
};
