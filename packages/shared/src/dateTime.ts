import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const isZonedIsoDateTime = Schema.is(
  Schema.String.check(
    Schema.isPattern(
      /^(?:\d{4}|[+-]\d{6})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?|24:00(?::00(?:\.0+)?)?)(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/,
    ),
    Schema.isTrimmed(),
  ),
);

function parseTimestamp(value: string): number {
  if (!isZonedIsoDateTime(value)) return Number.NaN;

  // Engines can normalize invalid calendar dates instead of rejecting them.
  const datePart = value.slice(0, value.indexOf("T"));
  const date = DateTime.make(`${datePart}T00:00:00.000Z`);
  if (Option.isNone(date)) return Number.NaN;
  const parts = DateTime.toPartsUtc(date.value);
  if (parts.month !== Number(datePart.slice(-5, -3)) || parts.day !== Number(datePart.slice(-2))) {
    return Number.NaN;
  }
  return Date.parse(value);
}

/** Compare date-time strings by absolute time, with stable handling for malformed stored values. */
export function compareDateTimeStrings(left: string, right: string): number {
  const leftTimestamp = parseTimestamp(left);
  const rightTimestamp = parseTimestamp(right);
  const leftIsValid = !Number.isNaN(leftTimestamp);
  const rightIsValid = !Number.isNaN(rightTimestamp);

  if (leftIsValid !== rightIsValid) return leftIsValid ? 1 : -1;
  if (leftIsValid) return leftTimestamp - rightTimestamp;
  return left < right ? -1 : left > right ? 1 : 0;
}
