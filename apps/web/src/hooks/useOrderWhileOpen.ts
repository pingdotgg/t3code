import { useState } from "react";

/** Sorts `items` into `order` by key. Items missing from `order` follow, in their own order. */
export function keepOrder<T>(
  items: ReadonlyArray<T>,
  order: ReadonlyArray<string> | null,
  key: (item: T) => string,
): T[] {
  if (order === null) return [...items];
  const rank = new Map(order.map((itemKey, index) => [itemKey, index]));
  return items
    .map((item, index) => ({ item, rank: rank.get(key(item)) ?? order.length + index }))
    .toSorted((a, b) => a.rank - b.rank)
    .map(({ item }) => item);
}

/** `order` with keys it has not seen added at the end, or `order` itself when nothing is new. */
export function withArrivedKeys(
  order: ReadonlyArray<string> | null,
  keys: ReadonlyArray<string>,
): ReadonlyArray<string> | null {
  const known = new Set(order);
  const arrived = keys.filter((itemKey) => !known.has(itemKey));
  return arrived.length === 0 ? order : [...(order ?? []), ...arrived];
}

/**
 * Keeps the order a list had when it opened, so a row that a pin moves does not slide out
 * from under the pointer or the keyboard highlight. Rows that load later join at the end and
 * then hold their place too. The new order shows on the next open.
 */
export function useOrderWhileOpen<T>(
  items: ReadonlyArray<T>,
  key: (item: T) => string,
  open: boolean,
): T[] {
  const [order, setOrder] = useState<ReadonlyArray<string> | null>(null);
  if (!open) {
    if (order !== null) setOrder(null);
    return [...items];
  }
  const ordered = keepOrder(items, order, key);
  const nextOrder = withArrivedKeys(order, ordered.map(key));
  if (nextOrder !== order) setOrder(nextOrder);
  return ordered;
}
