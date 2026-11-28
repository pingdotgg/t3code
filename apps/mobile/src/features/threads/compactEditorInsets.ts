const COMPACT_EDITOR_SLOT_INSET = 4;

/**
 * Places the floating editor over its slot. Layout x is measured from the left,
 * but start and end follow the layout direction, so in RTL the insets trade places.
 */
export function compactEditorInsets(input: {
  readonly slotX: number;
  readonly slotWidth: number;
  readonly rowWidth: number;
  readonly isRTL: boolean;
}): { start: number; end: number } {
  "worklet";
  const fromLeft = input.slotX + COMPACT_EDITOR_SLOT_INSET;
  const fromRight = input.rowWidth - input.slotX - input.slotWidth + COMPACT_EDITOR_SLOT_INSET;
  return input.isRTL ? { start: fromRight, end: fromLeft } : { start: fromLeft, end: fromRight };
}
