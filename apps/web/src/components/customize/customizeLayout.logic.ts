/**
 * Where Customize interface places each palette. Palettes sit beside the
 * surface they edit, never on top of it, so every change is visible the
 * moment it's made.
 */

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type PaletteId = "threadList" | "chatHeader" | "appearance" | "composer";

export interface PaletteLayoutInput {
  readonly viewport: { readonly width: number; readonly height: number };
  /** Null when the surface isn't on screen (a collapsed sidebar, a page without a composer). */
  readonly sidebar: Rect | null;
  readonly header: Rect | null;
  readonly composer: Rect | null;
  readonly sizes: Readonly<Record<PaletteId, { readonly width: number; readonly height: number }>>;
  /** The mode's own bar in the bottom-left corner. */
  readonly dock: { readonly width: number; readonly height: number };
}

export const PALETTE_MARGIN = 12;
/**
 * How much of a palette must stay on screen. A taller palette keeps its
 * anchored top and scrolls its body rather than climbing over its neighbours.
 */
const MIN_VISIBLE_PALETTE_HEIGHT = 200;
/** Below this width the palettes collapse into one tabbed sheet. */
const COMPACT_LAYOUT_MAX_WIDTH = 960;

/**
 * Floating palettes need three columns between the sidebar and the chat
 * column's right edge (a right-hand panel narrows it): the thread list's, the
 * composer's, and the header and appearance column. Narrower spaces use the
 * tabbed sheet, since the composer palette would otherwise cover the others.
 */
export function shouldUseCompactPaletteLayout(input: {
  readonly viewportWidth: number;
  readonly sidebar: Rect | null;
  readonly header: Rect | null;
  readonly paletteWidth: number;
}): boolean {
  const contentLeft = isVisible(input.sidebar, input.viewportWidth) ? input.sidebar.right : 0;
  const contentRight = isVisible(input.header, input.viewportWidth)
    ? input.header.right
    : input.viewportWidth;
  return (
    input.viewportWidth < COMPACT_LAYOUT_MAX_WIDTH ||
    3 * input.paletteWidth + 4 * PALETTE_MARGIN > contentRight - contentLeft
  );
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function isVisible(rect: Rect | null, viewportWidth: number): rect is Rect {
  return rect !== null && rect.right - rect.left > 1 && rect.right > 0 && rect.left < viewportWidth;
}

export function resolvePaletteLayout(input: PaletteLayoutInput): Record<PaletteId, Point> {
  const { viewport, sizes } = input;
  const m = PALETTE_MARGIN;
  const place = (id: PaletteId, x: number, y: number, minY = m): Point => {
    const visibleHeight = Math.min(sizes[id].height, MIN_VISIBLE_PALETTE_HEIGHT);
    return {
      x: Math.round(clamp(x, m, Math.max(m, viewport.width - sizes[id].width - m))),
      y: Math.round(clamp(y, minY, Math.max(minY, viewport.height - visibleHeight - m))),
    };
  };

  const sidebar = isVisible(input.sidebar, viewport.width) ? input.sidebar : null;
  const header = isVisible(input.header, viewport.width) ? input.header : null;
  const composer = isVisible(input.composer, viewport.width) ? input.composer : null;
  const contentLeft = sidebar ? sidebar.right : 0;
  const contentRight = header ? header.right : viewport.width;
  const contentTop = header ? header.bottom : 0;

  // Just right of the sidebar, level with its first rows.
  const threadList = place(
    "threadList",
    contentLeft + m,
    (sidebar ? sidebar.top : 0) + (header ? header.bottom - header.top : 48) + m,
  );

  // Hanging under the header's actions, right-aligned with them.
  // Nothing in the chat column climbs over its header.
  const columnTop = contentTop + m;
  const chatHeader = place("chatHeader", contentRight - sizes.chatHeader.width - m, columnTop);

  // The appearance column continues below the header palette.
  const appearanceTop = chatHeader.y + sizes.chatHeader.height + m;
  const appearance = place(
    "appearance",
    contentRight - sizes.appearance.width - m,
    appearanceTop,
    columnTop,
  );

  // Centered over the composer, but kept clear of the side columns when the
  // chat column is too narrow to hold it between them.
  const composerWidth = sizes.composer.width;
  const leftBound = threadList.x + sizes.threadList.width + m;
  const rightBound = appearance.x - m;
  const composerCenter = composer
    ? (composer.left + composer.right) / 2
    : (contentLeft + contentRight) / 2;
  let composerX = composerCenter - composerWidth / 2;
  if (rightBound - leftBound >= composerWidth) {
    composerX = clamp(composerX, leftBound, rightBound - composerWidth);
  }
  // Above the composer when it fits; a composer centred in an empty thread
  // may leave more room below it.
  const spaceAbove = composer ? composer.top - columnTop - m : 0;
  const spaceBelow = composer ? viewport.height - composer.bottom - 2 * m : 0;
  const composerY = !composer
    ? viewport.height - input.dock.height - sizes.composer.height - 2 * m
    : spaceAbove < sizes.composer.height && spaceBelow > spaceAbove
      ? composer.bottom + m
      : composer.top - sizes.composer.height - m;
  const composerPoint = place("composer", composerX, composerY, columnTop);

  return { threadList, chatHeader, appearance, composer: composerPoint };
}
