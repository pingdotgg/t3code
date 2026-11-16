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
