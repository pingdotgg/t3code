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
  readonly topInset?: number;
  readonly bottomInset?: number;
  readonly gap?: number;
}): ComposerPopoverPlacement {
  const gap = input.gap ?? 8;
  const topInset = input.topInset ?? 0;
  const bottomInset = input.bottomInset ?? 0;
  const availableBottom = Math.max(topInset, input.windowHeight - bottomInset);
  const left = Math.min(
    Math.max(0, input.anchor.x),
    Math.max(0, input.windowWidth - input.menuWidth),
  );
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

  return { left, top, width: Math.min(input.menuWidth, input.windowWidth) };
}
