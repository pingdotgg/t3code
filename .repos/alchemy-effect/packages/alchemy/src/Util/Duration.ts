import * as Duration from "effect/Duration";

/**
 * Convert a {@link Duration.Input} to whole, non-negative
 * milliseconds. Returns `undefined` when `input` is `undefined`,
 * so call sites can map through optional duration fields without
 * a branch.
 */
export const toMillis = (input: Duration.Input | undefined) =>
  input === undefined
    ? undefined
    : Math.max(0, Math.ceil(Duration.toMillis(input)));

/**
 * Convert a {@link Duration.Input} to whole, non-negative seconds.
 * Returns `undefined` when `input` is `undefined`.
 */
export const toSeconds = (input: Duration.Input | undefined) =>
  input === undefined
    ? undefined
    : Math.max(0, Math.ceil(Duration.toSeconds(input)));
