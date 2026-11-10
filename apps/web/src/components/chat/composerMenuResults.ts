export function retainPendingComposerMenuItems<T>(
  previous: { scope: string | null; items: T[] },
  scope: string | null,
  items: T[],
  isPending: boolean,
): T[] {
  return isPending && scope !== null && previous.scope === scope && previous.items.length > 0
    ? previous.items
    : items;
}
