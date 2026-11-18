// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/desktop-helper/src/validate.ts), modified for Ada.
/**
 * Small hand validators in place of a schema library (the helper has no runtime dependencies). Each
 * returns the value with its type when the shape is right and throws a ShapeError naming the field
 * when it is not, so a script's output or a frame from the box is never used half-checked.
 */
export class ShapeError extends Error {}

export type Fields = Record<string, unknown>;

const fail = (what: string, expected: string): never => {
  throw new ShapeError(`${what} should be ${expected}`);
};

export function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function object(value: unknown, what: string): Fields {
  return isObject(value) ? value : fail(what, "an object");
}

export function string(value: unknown, what: string): string {
  return typeof value === "string" ? value : fail(what, "a string");
}

export function number(value: unknown, what: string): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fail(what, "a number");
}

/** A whole number from `min` to `max`. */
export function integerIn(value: unknown, min: number, max: number, what: string): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fail(what, `a whole number from ${min} to ${max}`);
}

export function boolean(value: unknown, what: string): boolean {
  return typeof value === "boolean" ? value : fail(what, "true or false");
}

export function optional<T>(
  value: unknown,
  what: string,
  check: (value: unknown, what: string) => T,
): T | undefined {
  return value === undefined ? undefined : check(value, what);
}

export function nullable<T>(
  value: unknown,
  what: string,
  check: (value: unknown, what: string) => T,
): T | null {
  return value === null ? null : check(value, what);
}

export function array<T>(
  value: unknown,
  what: string,
  item: (value: unknown, what: string) => T,
): T[] {
  if (!Array.isArray(value)) return fail(what, "a list");
  return value.map((entry, index) => item(entry, `${what}[${index}]`));
}

/** One of a closed set of strings. */
export function oneOf<const T extends readonly string[]>(
  value: unknown,
  options: T,
  what: string,
): T[number] {
  return typeof value === "string" && options.includes(value)
    ? (value as T[number])
    : fail(what, `one of ${options.join(", ")}`);
}

/** JSON text, parsed; a parse failure is a ShapeError too. */
export function json(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail(what, "JSON");
  }
}
