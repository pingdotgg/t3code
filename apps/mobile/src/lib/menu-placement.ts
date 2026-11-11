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
