export type ComposerAnchorRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type ComposerPopoverPlacement = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
};

export function isComposerCommandPopoverPlacementReady(
  placement: ComposerPopoverPlacement | null,
): placement is ComposerPopoverPlacement {
  return placement !== null;
}

/**
 * Positions the menu in window coordinates. The composer remains in the
 * normal layout; only the menu's independent overlay position changes.
 */
export function placeComposerCommandPopover(input: {
  readonly anchor: ComposerAnchorRect;
  readonly menuWidth: number;
  readonly menuHeight: number;
  readonly windowWidth: number;
  readonly windowHeight: number;
  readonly leftInset?: number;
  readonly rightInset?: number;
  readonly topInset?: number;
  readonly bottomInset?: number;
  readonly gap?: number;
}): ComposerPopoverPlacement {
  const gap = input.gap ?? 8;
  const leftInset = input.leftInset ?? 0;
  const rightInset = input.rightInset ?? 0;
  const topInset = input.topInset ?? 0;
  const bottomInset = input.bottomInset ?? 0;
  const usableLeft = Math.min(input.windowWidth, Math.max(0, leftInset));
  const usableRight = Math.max(usableLeft, input.windowWidth - Math.max(0, rightInset));
  const width = Math.min(input.menuWidth, usableRight - usableLeft);
  const availableBottom = Math.max(topInset, input.windowHeight - bottomInset);
  const left = Math.min(Math.max(usableLeft, input.anchor.x), usableRight - width);
  const above = input.anchor.y - input.menuHeight - gap;
  const below = input.anchor.y + input.anchor.height + gap;
  const top =
    above >= topInset
      ? above
      : below + input.menuHeight <= availableBottom
        ? below
        : Math.min(
            Math.max(topInset, above),
            Math.max(topInset, availableBottom - input.menuHeight),
          );

  return { left, top, width };
}
