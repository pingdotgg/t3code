import type { PreviewMiniPlayerFrame } from "../preview/previewMiniPlayerLayout";

export function resolveThreadDetailsCardDensity(
  height: number,
  content: { full: number; compact: number },
) {
  if (content.full === 0 || content.full <= height) return "full";
  if (content.compact === 0 || content.compact <= height) return "compact";
  return "essential";
}

export function resolveThreadDetailsCardLayout({
  container,
  frame,
  overlapsDetailsCard = false,
  padding = 20,
  minChatWidth = 640,
}: {
  container: { width: number; height: number };
  frame: PreviewMiniPlayerFrame | null;
  overlapsDetailsCard?: boolean;
  padding?: number;
  minChatWidth?: number;
}) {
  const gap = 12;
  if (container.width <= gap * 2 || container.height <= gap * 2) return null;
  const sideWidth = Math.min(312, container.width - minChatWidth - padding * 2 - gap * 2);
  const stacked = sideWidth < 240;
  const width = stacked ? container.width - gap * 2 : sideWidth;
  const x = container.width - width - gap;
  // Resizing consumes the height above the player. Dragging first tries to
  // clear the full card and folds it only when there is no readable placement.
  const availableHeight = container.height - gap * 2;
  const height = stacked
    ? Math.min(200, availableHeight * 0.3)
    : overlapsDetailsCard && frame && frame.x + frame.width > x - gap && frame.x < x + width + gap
      ? Math.min(availableHeight, Math.max(160, frame.y - gap * 2))
      : availableHeight;
  return {
    x,
    width,
    y: gap,
    height,
    stacked,
  } as const;
}
