import type { VerticalHinge } from "./layout";

/** Keep menus on their anchor's side of a creased hinge. */
export function deriveMenuHorizontalPlacement(input: {
  readonly anchorX: number;
  readonly anchorWidth: number;
  readonly overlayWidth: number;
  readonly desiredWidth: number;
  readonly margin: number;
  /** In the overlay's coordinates. */
  readonly hinge: VerticalHinge | null;
}) {
  const center = input.anchorX + input.anchorWidth / 2;
  let start = 0;
  let end = input.overlayWidth;
  if (input.hinge) {
    if (center < input.hinge.x) end = input.hinge.x;
    else start = input.hinge.x + input.hinge.width;
  }
  const width = Math.min(input.desiredWidth, Math.max(0, end - start - 2 * input.margin));
  const preferredLeft =
    center <= (start + end) / 2 ? input.anchorX : input.anchorX + input.anchorWidth - width;
  const left = Math.min(Math.max(preferredLeft, start + input.margin), end - width - input.margin);
  return { left, width };
}

/** In the overlay's coordinates; `bottom` is measured up from the overlay's bottom edge. */
export function deriveMenuVerticalPlacement(input: {
  readonly anchorY: number;
  readonly anchorHeight: number;
  readonly overlayHeight: number;
  readonly keyboardInset: number;
  readonly gap: number;
  readonly margin: number;
  readonly minHeight: number;
}) {
  const usableBottom = input.overlayHeight - input.keyboardInset;
  const spaceBelow = usableBottom - (input.anchorY + input.anchorHeight) - input.gap - input.margin;
  const spaceAbove = input.anchorY - input.gap - input.margin;
  const opensDown = spaceBelow >= 280 || spaceBelow >= spaceAbove;
  const maxHeight = Math.min(opensDown ? spaceBelow : spaceAbove, 480);
  if (maxHeight < input.minHeight) {
    // Neither side fits (e.g. a code block taller than the screen): overlap the anchor instead.
    const top = Math.max(
      input.margin,
      Math.min(input.anchorY, usableBottom - input.margin - input.minHeight),
    );
    return { maxHeight: Math.min(usableBottom - input.margin - top, 480), top };
  }
  return opensDown
    ? { maxHeight, top: input.anchorY + input.anchorHeight + input.gap }
    : { maxHeight, bottom: input.overlayHeight - input.anchorY + input.gap };
}
