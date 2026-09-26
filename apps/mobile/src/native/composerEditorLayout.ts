/** Return a finite numeric style length, or undefined for non-numeric values. */
export function numericStyleLength(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Vertical padding declared on the editor style. Android's wrapper View
 * insets by this amount, so it belongs in the laid-out height.
 */
export function verticalPaddingFromViewStyle(style: {
  readonly padding?: unknown;
  readonly paddingVertical?: unknown;
  readonly paddingTop?: unknown;
  readonly paddingBottom?: unknown;
}): number {
  const padding = numericStyleLength(style.padding) ?? 0;
  const paddingVertical = numericStyleLength(style.paddingVertical) ?? padding;
  const top = numericStyleLength(style.paddingTop) ?? paddingVertical;
  const bottom = numericStyleLength(style.paddingBottom) ?? paddingVertical;
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
