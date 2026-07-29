import * as Redacted from "effect/Redacted";

/**
 * Distilled decodes `smithy.api#sensitive` strings to `Redacted<string>` on
 * responses while accepting plain strings on requests. Attributes expose
 * plain strings, so unwrap defensively.
 */
export const unredact = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

/**
 * Audit Manager tag maps arrive as `{ [key]: string | undefined }` — narrow
 * to the `Record<string, string>` shape the Tags helpers expect.
 */
export const toTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
