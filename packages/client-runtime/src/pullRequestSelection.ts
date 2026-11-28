import { PULL_REQUEST_CHANGE_BATCH_LIMIT } from "@t3tools/contracts";

/** Picks that differ from the host, keyed by candidate. Nothing is sent until the picker closes. */
export type SelectionDraft<T> = ReadonlyMap<
  string,
  { readonly item: T; readonly selected: boolean }
>;

export function emptySelection<T>(): SelectionDraft<T> {
  return new Map();
}

export function isSelected<T>(draft: SelectionDraft<T>, key: string, hostSelected: boolean) {
  return draft.get(key)?.selected ?? hostSelected;
}

export function toggleSelection<T>(
  draft: SelectionDraft<T>,
  key: string,
  item: T,
  hostSelected: boolean,
): SelectionDraft<T> {
  const next = new Map(draft);
  const selected = !isSelected(draft, key, hostSelected);
  if (selected === hostSelected) next.delete(key);
  else next.set(key, { item, selected });
  return next;
}

/** For a host that keeps one reviewer: picking someone takes everyone else off. */
export function toggleOnlySelection<T>(
  draft: SelectionDraft<T>,
  key: string,
  item: T,
  hostSelected: boolean,
  listed: ReadonlyArray<{ readonly key: string; readonly item: T; readonly hostSelected: boolean }>,
): SelectionDraft<T> {
  const next = toggleSelection(draft, key, item, hostSelected);
  if (!isSelected(next, key, hostSelected)) return next;
  const only = new Map([...next].filter(([other, pick]) => other === key || !pick.selected));
  for (const other of listed) {
    if (other.key !== key && other.hostSelected) {
      only.set(other.key, { item: other.item, selected: false });
    }
  }
  return only;
}

/**
 * What to send on close, diffed against the host's latest state rather than the state when the
 * pick was made, so a refresh while the picker was open does not resend anything.
 */
export function selectionChanges<T>(
  draft: SelectionDraft<T>,
  hostSelected: (key: string, item: T) => boolean,
): { readonly add: ReadonlyArray<T>; readonly remove: ReadonlyArray<T> } {
  const add: T[] = [];
  const remove: T[] = [];
  for (const [key, { item, selected }] of draft) {
    if (selected === hostSelected(key, item)) continue;
    (selected ? add : remove).push(item);
  }
  return { add, remove };
}

/** Splits a change into writes the contract accepts. */
export function changeBatches<T>(items: ReadonlyArray<T>): ReadonlyArray<ReadonlyArray<T>> {
  const batches: Array<ReadonlyArray<T>> = [];
  for (let start = 0; start < items.length; start += PULL_REQUEST_CHANGE_BATCH_LIMIT) {
    batches.push(items.slice(start, start + PULL_REQUEST_CHANGE_BATCH_LIMIT));
  }
  return batches;
}
