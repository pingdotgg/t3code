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
  readonly trailingGap?: number;
}): { left: number; right: number } {
  "worklet";
  const trailingGap = input.trailingGap ?? COMPACT_EDITOR_SLOT_INSET;
  const fromLeft = input.slotX + (input.isRTL ? trailingGap : COMPACT_EDITOR_SLOT_INSET);
  const fromRight =
    input.rowWidth -
    input.slotX -
    input.slotWidth +
    (input.isRTL ? COMPACT_EDITOR_SLOT_INSET : trailingGap);
  return input.isRTL ? { left: fromRight, right: fromLeft } : { left: fromLeft, right: fromRight };
}
