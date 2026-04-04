export function sortCopy<T>(
  values: ReadonlyArray<T>,
  compareFn: (left: T, right: T) => number,
): T[] {
  const next = [...values];

  for (let index = 1; index < next.length; index += 1) {
    const current = next[index];
    if (current === undefined) {
      continue;
    }

    let insertionIndex = index - 1;
    while (insertionIndex >= 0) {
      const candidate = next[insertionIndex];
      if (candidate !== undefined && compareFn(candidate, current) <= 0) {
        break;
      }

      next[insertionIndex + 1] = candidate;
      insertionIndex -= 1;
    }

    next[insertionIndex + 1] = current;
  }

  return next;
}

export function reverseCopy<T>(values: ReadonlyArray<T>): T[] {
  const reversed = Array.from({ length: values.length }) as T[];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) {
      continue;
    }
    reversed[values.length - 1 - index] = value;
  }

  return reversed;
}
