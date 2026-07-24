import type { PreviewMiniPlayerPosition, PreviewMiniPlayerSize } from "~/previewMiniPlayerStore";

export const PREVIEW_MINI_PLAYER_EDGE_GAP = 12;
export const PREVIEW_MINI_PLAYER_DEFAULT_SIZE = { width: 360, height: 239 } as const;
export const PREVIEW_MINI_PLAYER_MIN_SIZE = { width: 280, height: 194 } as const;

export function clampPreviewMiniPlayerSize(
  size: PreviewMiniPlayerSize,
  container: PreviewMiniPlayerSize,
  bottomInset = 0,
): PreviewMiniPlayerSize {
  return {
    width: Math.round(
      Math.min(
        Math.max(PREVIEW_MINI_PLAYER_MIN_SIZE.width, size.width),
        Math.max(
          PREVIEW_MINI_PLAYER_MIN_SIZE.width,
          container.width - PREVIEW_MINI_PLAYER_EDGE_GAP * 2,
        ),
      ),
    ),
    height: Math.round(
      Math.min(
        Math.max(PREVIEW_MINI_PLAYER_MIN_SIZE.height, size.height),
        Math.max(
          PREVIEW_MINI_PLAYER_MIN_SIZE.height,
          container.height - Math.max(0, bottomInset) - PREVIEW_MINI_PLAYER_EDGE_GAP * 2,
        ),
      ),
    ),
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
