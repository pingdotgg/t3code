import type { PreviewMiniPlayerPosition, PreviewMiniPlayerSize } from "~/previewMiniPlayerStore";

export const PREVIEW_MINI_PLAYER_EDGE_GAP = 12;
export const PREVIEW_MINI_PLAYER_DEFAULT_SIZE = { width: 320, height: 200 } as const;
export const PREVIEW_MINI_PLAYER_MIN_SIZE = { width: 240, height: 150 } as const;

export function clampPreviewMiniPlayerSize(
  size: PreviewMiniPlayerSize,
  container: PreviewMiniPlayerSize,
  bottomInset = 0,
): PreviewMiniPlayerSize {
  const availableWidth = Math.max(1, container.width - PREVIEW_MINI_PLAYER_EDGE_GAP * 2);
  const availableHeight = Math.max(
    1,
    container.height - Math.max(0, bottomInset) - PREVIEW_MINI_PLAYER_EDGE_GAP * 2,
  );
  return {
    width: Math.round(
      Math.min(Math.max(PREVIEW_MINI_PLAYER_MIN_SIZE.width, size.width), availableWidth),
    ),
    height: Math.round(
      Math.min(Math.max(PREVIEW_MINI_PLAYER_MIN_SIZE.height, size.height), availableHeight),
    ),
  };
}

/**
 * Default spot for a freshly opened mini player. Normally the top-right CSS
 * placement stands (`fallback`), but when the inline thread-details panel is
 * open its card occupies that corner — slide the player underneath the card,
 * right edges aligned, so neither surface covers the other. The result still
 * goes through `clampPreviewMiniPlayerPosition`, which pulls the player back
 * up when a tall card would push it into the composer.
 */
export function defaultPreviewMiniPlayerPosition(input: {
  readonly fallback: PreviewMiniPlayerPosition;
  readonly parentRect: { readonly left: number; readonly top: number };
  readonly playerWidth: number;
  readonly detailsCardRect: { readonly right: number; readonly bottom: number } | null;
}): PreviewMiniPlayerPosition {
  if (input.detailsCardRect === null) return input.fallback;
  return {
    x: input.detailsCardRect.right - input.parentRect.left - input.playerWidth,
    y: input.detailsCardRect.bottom - input.parentRect.top + PREVIEW_MINI_PLAYER_EDGE_GAP,
  };
}

export function clampPreviewMiniPlayerPosition(
  position: PreviewMiniPlayerPosition,
  container: PreviewMiniPlayerSize,
  player: PreviewMiniPlayerSize,
  bottomInset = 0,
): PreviewMiniPlayerPosition {
  const reservedBottomSpace = Math.max(0, bottomInset);
  const maxX = Math.max(
    PREVIEW_MINI_PLAYER_EDGE_GAP,
    container.width - player.width - PREVIEW_MINI_PLAYER_EDGE_GAP,
  );
  const maxY = Math.max(
    PREVIEW_MINI_PLAYER_EDGE_GAP,
    container.height - reservedBottomSpace - player.height - PREVIEW_MINI_PLAYER_EDGE_GAP,
  );
  return {
    x: Math.min(Math.max(position.x, PREVIEW_MINI_PLAYER_EDGE_GAP), maxX),
    y: Math.min(Math.max(position.y, PREVIEW_MINI_PLAYER_EDGE_GAP), maxY),
  };
}
