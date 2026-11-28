/**
 * Shared tab multi-selection and bulk tab-list helpers used by both the
 * right-panel tab strip and the redesign's layout pane tab strip.
 */

/** Contiguous slice between `anchorId` and `endId` (inclusive), in list order. */
export function selectTabRange<T>(
  items: readonly T[],
  getId: (item: T) => string,
  anchorId: string,
  endId: string,
): T[] {
  const anchorIndex = items.findIndex((item) => getId(item) === anchorId);
  const endIndex = items.findIndex((item) => getId(item) === endId);
  if (anchorIndex < 0 || endIndex < 0) return [];
  return items.slice(Math.min(anchorIndex, endIndex), Math.max(anchorIndex, endIndex) + 1);
}

/**
 * Fallback active id after removing `closingIds` from `items`: preserves the
 * slot where the active item sat, clamping to the last remaining item.
 */
export function nextActiveIdAfterBulkClose<T>(
  items: readonly T[],
  getId: (item: T) => string,
  activeId: string | null,
  closingIds: ReadonlySet<string>,
): string | null {
  if (activeId === null || !closingIds.has(activeId)) return activeId;
  const remaining = items.filter((item) => !closingIds.has(getId(item)));
  const activeIndex = items.findIndex((item) => getId(item) === activeId);
  const fallbackIndex = items
    .slice(0, activeIndex)
    .filter((item) => !closingIds.has(getId(item))).length;
  const fallback = remaining[Math.min(fallbackIndex, remaining.length - 1)];
  return fallback ? getId(fallback) : null;
}

/**
 * Move every item in `movingIds` together (preserving relative order) to
 * `insertIndex` within the remaining items.
 */
export function reorderTabGroup<T>(
  items: readonly T[],
  getId: (item: T) => string,
  movingIds: ReadonlySet<string>,
  insertIndex: number,
): T[] {
  const moving = items.filter((item) => movingIds.has(getId(item)));
  const remaining = items.filter((item) => !movingIds.has(getId(item)));
  const clamped = Math.max(0, Math.min(insertIndex, remaining.length));
  remaining.splice(clamped, 0, ...moving);
  return remaining;
}
