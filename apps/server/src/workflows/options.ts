import * as Duration from "effect/Duration";
import * as Option from "effect/Option";

/** The duration `input` is, or an error that names `what` and shows one that reads. */
export const durationOf = (what: string, input: Duration.Input): Duration.Duration =>
  Option.getOrThrowWith(
    Duration.fromInput(input),
    () =>
      new Error(
        `${what} cannot read ${JSON.stringify(input)} as a duration. Write one such as "5 minutes".`,
      ),
  );

/**
 * Refuses an option the call does not take. A workflow file is not type-checked, so a misspelt or
 * renamed option would otherwise be dropped without a word.
 */
export const checkOptions = (
  what: string,
  options: object | undefined,
  allowed: ReadonlyArray<string>,
) => {
  if (options === undefined || options === null) return;
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  const listed = (keys: ReadonlyArray<string>) => keys.map((key) => `\`${key}\``).join(", ");
  throw new Error(`${what} does not take ${listed(unknown)}. It takes ${listed(allowed)}.`);
};
