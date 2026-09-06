import type { PreviewMiniPlayerPosition, PreviewMiniPlayerSize } from "~/previewMiniPlayerStore";

export const PREVIEW_MINI_PLAYER_EDGE_GAP = 12;
// The mini-player shell straddles this webview at 47 and 49; dialogs begin at 50.
export const PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX = 48;
export const PREVIEW_MINI_PLAYER_DEFAULT_SIZE = { width: 320, height: 200 } as const;
const PREVIEW_MINI_PLAYER_MIN_SIZE = { width: 240, height: 150 } as const;

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
