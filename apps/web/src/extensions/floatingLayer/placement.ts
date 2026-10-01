/** Popovers keep this far from the viewport edges, in CSS px. */
export const FLOATING_VIEWPORT_MARGIN = 8;

export interface FloatingPlacement {
  readonly left: number;
  readonly top: number;
  /** The space available on the chosen side; taller content scrolls. */
  readonly maxHeight: number;
}

/**
 * Where a popover goes against its anchor, from viewport-relative rects. Like
 * the native menu positioner, a side opener flips to the roomier side when
 * its content does not fit, and the height cap is the available height there.
 */
export function placeFloating(input: {
  readonly anchor: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  /** Natural, uncapped size of the popover. */
  readonly content: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly side: "bottom" | "top" | "inset";
  readonly align: "start" | "end";
  readonly offset: number;
}): FloatingPlacement {
  const { anchor, content, viewport, side, align, offset } = input;
  const margin = FLOATING_VIEWPORT_MARGIN;
  const inset = side === "inset" ? offset : 0;
  const preferredLeft =
    align === "start" ? anchor.left + inset : anchor.right - inset - content.width;
  const left = Math.max(margin, Math.min(preferredLeft, viewport.width - margin - content.width));

  if (side === "inset") {
    const top = Math.max(margin, anchor.top + offset);
    return { left, top, maxHeight: Math.max(0, viewport.height - margin - top) };
  }
  const below = Math.max(0, viewport.height - margin - (anchor.bottom + offset));
  const above = Math.max(0, anchor.top - offset - margin);
  const opensBelow =
    side === "bottom"
      ? content.height <= below || below >= above
      : !(content.height <= above || above >= below);
  if (opensBelow) return { left, top: anchor.bottom + offset, maxHeight: below };
  const height = Math.min(content.height, above);
  return { left, top: anchor.top - offset - height, maxHeight: above };
}
