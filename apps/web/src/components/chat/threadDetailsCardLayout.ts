import type { PreviewMiniPlayerFrame } from "../preview/previewMiniPlayerLayout";

export const THREAD_DETAILS_CARD_MIN_HEIGHT = 160;

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
  maxChatWidth = 768,
}: {
  container: { width: number; height: number };
  frame: PreviewMiniPlayerFrame | null;
  overlapsDetailsCard?: boolean;
  padding?: number;
  minChatWidth?: number;
  maxChatWidth?: number;
}) {
  const gap = 12;
  if (container.width <= gap * 2 || container.height <= gap * 2) return null;
  const width = Math.min(
    312,
    Math.max(240, (container.width - maxChatWidth) / 2 - padding - gap * 2),
    container.width - minChatWidth - padding * 2 - gap * 2,
  );
  if (width < 240) return null;
  const x = container.width - width - gap;
  // Resizing consumes the height above the player. Dragging first tries to
  // clear the full card and folds it only when there is no readable placement.
  const availableHeight = container.height - gap * 2;
  const height =
    overlapsDetailsCard && frame && frame.x + frame.width > x - gap && frame.x < x + width + gap
      ? Math.min(availableHeight, frame.y - gap * 2)
      : availableHeight;
  if (height < THREAD_DETAILS_CARD_MIN_HEIGHT) return null;
  return {
    x,
    width,
    y: gap,
    height,
  } as const;
}
