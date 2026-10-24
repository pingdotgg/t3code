/** Positions compact menus above the composer and expanded menus next to the text selection. */
const VIEWPORT_PADDING_PX = 24;
const MIN_MENU_HEIGHT_PX = 96;
const COMPOSER_BORDER_WIDTH_PX = 1;

type Rect = { top: number; left: number; width: number };
type CaretRect = { top: number; bottom: number };

export type ComposerCommandMenuPosition = {
  left: number;
  maxHeight: number;
  width: number;
} & ({ top: number; bottom?: never } | { bottom: number; top?: never });

export function composerCommandMenuPosition({
  rect,
  caret,
  maximized,
  viewportHeight,
  rootFontSize,
  drawerInset,
}: {
  rect: Rect;
  caret: CaretRect | null;
  maximized: boolean;
  viewportHeight: number;
  rootFontSize: number;
  drawerInset: number;
}): ComposerCommandMenuPosition | null {
  const width = rect.width - drawerInset * 2;
  if (width <= 0) return null;
  const horizontal = { left: rect.left + drawerInset, width };
  const composerOverlap = rootFontSize + COMPOSER_BORDER_WIDTH_PX;
  if (!maximized) {
    return {
      ...horizontal,
      bottom: viewportHeight - rect.top - composerOverlap,
      maxHeight: Math.max(MIN_MENU_HEIGHT_PX, rect.top - VIEWPORT_PADDING_PX + composerOverlap),
    };
  }

  const viewportTop = Math.max(VIEWPORT_PADDING_PX, rect.top);
  const viewportBottom = viewportHeight - VIEWPORT_PADDING_PX;
  const caretTop = Math.max(viewportTop, Math.min(caret?.top ?? viewportTop, viewportBottom));
  const caretBottom = Math.max(caretTop, Math.min(caret?.bottom ?? caretTop, viewportBottom));
  const spaceAbove = Math.max(0, caretTop - viewportTop - rootFontSize);
  const spaceBelow = Math.max(0, viewportBottom - caretBottom - rootFontSize);
  if (spaceBelow >= MIN_MENU_HEIGHT_PX || spaceBelow >= spaceAbove) {
    return {
      ...horizontal,
      top: caretBottom + rootFontSize,
      maxHeight: spaceBelow,
    };
  }
  return {
    ...horizontal,
    bottom: viewportHeight - caretTop + rootFontSize,
    maxHeight: spaceAbove,
  };
}
