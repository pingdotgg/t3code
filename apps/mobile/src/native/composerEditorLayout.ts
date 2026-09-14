export function numericStyleLength(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Vertical padding declared on the editor style. Android's wrapper View
 * insets by this amount, so it belongs in the laid-out height. iOS assigns
 * the text view to the ExpoView bounds and does not inset by Yoga padding.
 */
export function verticalPaddingFromViewStyle(style: {
  readonly padding?: unknown;
  readonly paddingVertical?: unknown;
  readonly paddingTop?: unknown;
  readonly paddingBottom?: unknown;
}): number {
  const paddingVertical = numericStyleLength(style.paddingVertical);
  if (paddingVertical !== undefined) {
    return paddingVertical * 2;
  }
  const fallback = numericStyleLength(style.padding) ?? 0;
  const top = numericStyleLength(style.paddingTop) ?? fallback;
  const bottom = numericStyleLength(style.paddingBottom) ?? fallback;
  return top + bottom;
}

/**
 * Height of a min/max-bounded composer editor. A fixed `height` is a collapsed
 * frame and wins. Otherwise the native content height grows from min to max so
 * the caret is not clipped inside the minHeight box.
 */
export function composerEditorLaidOutHeight(input: {
  readonly contentHeight: number;
  readonly minHeight?: number;
  readonly maxHeight?: number;
  readonly height?: number;
  readonly verticalPadding: number;
}): number {
  if (typeof input.height === "number") {
    return input.height;
  }
  const minHeight = input.minHeight ?? 0;
  const maxHeight = input.maxHeight ?? Number.POSITIVE_INFINITY;
  const desired = Math.max(0, input.contentHeight) + input.verticalPadding;
  return Math.min(maxHeight, Math.max(minHeight, desired));
}
