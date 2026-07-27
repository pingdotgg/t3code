import * as Duration from "effect/Duration";

/**
 * Re-hydrate a {@link Duration.Input} that may have been persisted to (and
 * read back from) state as a structural `Duration` JSON.
 *
 * When a `Duration.Duration` round-trips through JSON state it is serialized
 * to `{ _id: "Duration", _tag: "Millis" | "Nanos" | "Infinity", ... }`, which
 * is NOT a valid {@link Duration.Input} on the way back in. This normalizes
 * such a value back to a plain input (`number` millis, `bigint` nanos, or the
 * `"Infinity"` literal). Any already-valid input (a number, a `"20 seconds"`
 * string, or a live `Duration`) is returned unchanged.
 */
export const normalizeDurationInput = (
  input: Duration.Input,
): Duration.Input => {
  const json = input as {
    _id?: unknown;
    _tag?: "Millis" | "Nanos" | "Infinity" | "NegativeInfinity";
    millis?: number;
    nanos?: string;
  };
  return json._id === "Duration"
    ? json._tag === "Millis"
      ? json.millis!
      : json._tag === "Nanos"
        ? BigInt(json.nanos!)
        : "Infinity"
    : input;
};

const wire =
  (to: (input: Duration.Input) => number) =>
  (input: Duration.Input | undefined): number | undefined =>
    input === undefined
      ? undefined
      : Math.round(to(normalizeDurationInput(input)));

/**
 * Convert a {@link Duration.Input} to whole seconds for a wire/API field,
 * normalizing any persisted-state `Duration` JSON first. Returns `undefined`
 * when `input` is `undefined` so call sites can map optional fields directly.
 */
export const toWireSeconds = wire(Duration.toSeconds);

/** Convert a {@link Duration.Input} to whole milliseconds for a wire/API field. */
export const toWireMillis = wire(Duration.toMillis);

/** Convert a {@link Duration.Input} to whole minutes for a wire/API field. */
export const toWireMinutes = wire(Duration.toMinutes);

/** Convert a {@link Duration.Input} to whole hours for a wire/API field. */
export const toWireHours = wire(Duration.toHours);

/** Convert a {@link Duration.Input} to whole days for a wire/API field. */
export const toWireDays = wire(Duration.toDays);

/**
 * Convert a {@link Duration.Input} to whole, non-negative
 * milliseconds. Returns `undefined` when `input` is `undefined`,
 * so call sites can map through optional duration fields without
 * a branch.
 */
export const toMillis = (input: Duration.Input | undefined) =>
  input === undefined
    ? undefined
    : Math.max(0, Math.ceil(Duration.toMillis(normalizeDurationInput(input))));

/**
 * Convert a {@link Duration.Input} to whole, non-negative seconds.
 * Returns `undefined` when `input` is `undefined`.
 */
export const toSeconds = (input: Duration.Input | undefined) =>
  input === undefined
    ? undefined
    : Math.max(0, Math.ceil(Duration.toSeconds(normalizeDurationInput(input))));
