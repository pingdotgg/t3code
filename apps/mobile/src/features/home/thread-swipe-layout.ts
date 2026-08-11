/**
 * Geometry for the row swipe tray, kept apart from the component so the
 * numbers can be asserted without loading React Native.
 */

// Wide enough for the longest action label ("Unarchive").
export const ACTION_ITEM_WIDTH = 58;

export function swipeActionsWidth(actionCount: number) {
  return ACTION_ITEM_WIDTH * Math.max(actionCount, 1);
}

/**
 * Reveal stagger for one button, by slot counted OUTWARD from the screen edge:
 * slot 0 is the outermost button and enters first. The two branches reproduce
 * the exact numbers the tray shipped with when it held one or two actions, so
 * widening it to three moves nothing on the lists that still pass two.
 */
export function swipeActionEntryRange(slot: number): readonly [number, number] {
  return slot === 0
    ? [8, ACTION_ITEM_WIDTH * 0.72]
    : [ACTION_ITEM_WIDTH * 0.55 * slot, ACTION_ITEM_WIDTH * 0.85 * (slot + 1)];
}
