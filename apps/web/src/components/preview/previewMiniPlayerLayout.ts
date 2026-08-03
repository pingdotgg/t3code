import type { PreviewMiniPlayerPosition, PreviewMiniPlayerSize } from "~/previewMiniPlayerStore";

export const PREVIEW_MINI_PLAYER_EDGE_GAP = 12;
export const PREVIEW_MINI_PLAYER_DEFAULT_SIZE = { width: 320, height: 200 } as const;
export const PREVIEW_MINI_PLAYER_MIN_SIZE = { width: 240, height: 150 } as const;

export function clampPreviewMiniPlayerSize(
  size: PreviewMiniPlayerSize,
  container: PreviewMiniPlayerSize,
): PreviewMiniPlayerSize {
  return {
    width: Math.round(
      Math.min(
        Math.max(PREVIEW_MINI_PLAYER_MIN_SIZE.width, size.width),
        Math.max(1, container.width - PREVIEW_MINI_PLAYER_EDGE_GAP * 2),
      ),
    ),
    height: Math.round(
      Math.min(
        Math.max(PREVIEW_MINI_PLAYER_MIN_SIZE.height, size.height),
        Math.max(1, container.height - PREVIEW_MINI_PLAYER_EDGE_GAP * 2),
      ),
    ),
  };
}

export function clampPreviewMiniPlayerPosition(
  position: PreviewMiniPlayerPosition,
  container: PreviewMiniPlayerSize,
  player: PreviewMiniPlayerSize,
): PreviewMiniPlayerPosition {
  return {
    x: Math.min(
      Math.max(position.x, PREVIEW_MINI_PLAYER_EDGE_GAP),
      Math.max(
        PREVIEW_MINI_PLAYER_EDGE_GAP,
        container.width - player.width - PREVIEW_MINI_PLAYER_EDGE_GAP,
      ),
    ),
    y: Math.min(
      Math.max(position.y, PREVIEW_MINI_PLAYER_EDGE_GAP),
      Math.max(
        PREVIEW_MINI_PLAYER_EDGE_GAP,
        container.height - player.height - PREVIEW_MINI_PLAYER_EDGE_GAP,
      ),
    ),
  };
}
