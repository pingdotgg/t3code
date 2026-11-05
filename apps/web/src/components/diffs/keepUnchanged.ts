import { useState } from "react";

interface VersionedItem {
  readonly id: string;
  readonly type: string;
  readonly version?: number | undefined;
}

/**
 * Keeps each item the viewer would treat as unchanged, since it ignores an item whose id, type and
 * version match, and the previous list when every item is kept. A new list makes it redraw.
 */
export function keepUnchangedItems<Item extends VersionedItem>(
  previous: ReadonlyArray<Item>,
  next: ReadonlyArray<Item>,
): ReadonlyArray<Item> {
  if (previous === next) return previous;
  const previousById = new Map(previous.map((item) => [item.id, item]));
  let changed = previous.length !== next.length;
  const kept = next.map((item, index) => {
    const old = previousById.get(item.id);
    const keep = old !== undefined && old.type === item.type && old.version === item.version;
    const result = keep ? old : item;
    if (result !== previous[index]) changed = true;
    return result;
  });
  return changed ? kept : previous;
}

export function keepShallowEqual<Value extends object>(previous: Value, next: Value): Value {
  if (previous === next) return previous;
  const previousKeys = Object.keys(previous);
  if (previousKeys.length !== Object.keys(next).length) return next;
  for (const key of previousKeys) {
    if (!Object.hasOwn(next, key) || Reflect.get(previous, key) !== Reflect.get(next, key)) {
      return next;
    }
  }
  return previous;
}

/** The value from the last render while `keep` finds nothing changed. */
export function useKeepUnchanged<Value>(
  next: Value,
  keep: (previous: Value, next: Value) => Value,
) {
  const [kept, setKept] = useState(next);
  const value = keep(kept, next);
  if (value !== kept) setKept(value);
  return value;
}
