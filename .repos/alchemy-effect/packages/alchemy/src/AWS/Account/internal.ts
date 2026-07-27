import * as Redacted from "effect/Redacted";

/**
 * Unwrap a distilled `SensitiveString` (`string | Redacted<string>`) into a
 * plain string, preserving `undefined`.
 *
 * The Account API marks contact fields (names, emails, phone numbers,
 * addresses) as sensitive at the wire level, so distilled returns them as
 * `string | Redacted<string>`. These are PII rather than credentials, so
 * alchemy stores them as plain strings in Attributes.
 */
export const unwrapSensitive = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);
