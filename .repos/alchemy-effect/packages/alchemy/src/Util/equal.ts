/**
 * Shallow, order-sensitive array equality. `undefined`-tolerant: two
 * `undefined`s are equal, an `undefined` and an array are not.
 *
 * Pass a custom `eq` comparator for non-primitive elements, e.g.
 * `(x, y) => JSON.stringify(x) === JSON.stringify(y)`.
 */
export const arrayEquals = <T>(
  a: ReadonlyArray<T> | undefined,
  b: ReadonlyArray<T> | undefined,
  eq: (x: T, y: T) => boolean = (x, y) => x === y,
): boolean => {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!eq(a[i], b[i])) return false;
  }
  return true;
};

/**
 * Order-insensitive array equality for primitive elements (compares
 * sorted copies). `undefined`-tolerant like {@link arrayEquals}.
 */
export const arrayEqualsUnordered = <T extends string | number>(
  a: ReadonlyArray<T> | undefined,
  b: ReadonlyArray<T> | undefined,
): boolean => {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  for (let i = 0; i < as.length; i++) {
    if (as[i] !== bs[i]) return false;
  }
  return true;
};

/**
 * Shallow equality of two string records (same keys, same values).
 */
export const recordsEqual = (
  a: Record<string, string>,
  b: Record<string, string>,
): boolean => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
};
