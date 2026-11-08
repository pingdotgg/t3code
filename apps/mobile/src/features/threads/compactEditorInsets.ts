const COMPACT_EDITOR_SLOT_INSET = 4;

/**
 * Places the floating editor over its slot. Layout x is measured from the left,
 * but React Native swaps left and right styles in RTL, so the insets trade places.
 */
export function compactEditorInsets(input: {
  readonly slotX: number;
  readonly slotWidth: number;
  readonly rowWidth: number;
  readonly isRTL: boolean;
}): { left: number; right: number } {
  "worklet";
  const fromLeft = input.slotX + COMPACT_EDITOR_SLOT_INSET;
  const fromRight = input.rowWidth - input.slotX - input.slotWidth + COMPACT_EDITOR_SLOT_INSET;
  return input.isRTL ? { left: fromRight, right: fromLeft } : { left: fromLeft, right: fromRight };
}
