import type { PreviewMiniPlayerFrame } from "../preview/previewMiniPlayerLayout";

export function resolveThreadDetailsCardDensity(
  height: number,
  content: { full: number; compact: number },
) {
  if (content.full === 0 || content.full <= height) return "full";
  if (content.compact === 0 || content.compact <= height) return "compact";
  return "essential";
}

/**
 * The card pins to the top right while a readable chat lane fits beside it.
 * The chat canvas decides whether chat moves over to make room.
 */
export function resolveThreadDetailsCardLayout({
  container,
  lane,
  frame,
  overlapsDetailsCard = false,
}: {
  container: { width: number; height: number };
  lane: { margin: number; minChatWidth: number };
  frame: PreviewMiniPlayerFrame | null;
  overlapsDetailsCard?: boolean;
}) {
  const gap = 12;
  // Keep in sync with --thread-details-panel-width, which sizes the popover.
  const width = 280;
  const x = container.width - width - gap;
  if (x - lane.margin * 2 < lane.minChatWidth) return null;
  // Resizing consumes the height above the player. Dragging first tries to
  // clear the full card and folds it only when there is no readable placement.
  const height =
    overlapsDetailsCard && frame && frame.x + frame.width > x - gap && frame.x < x + width + gap
      ? Math.min(container.height - gap * 2, frame.y - gap * 2)
      : container.height - gap * 2;
  if (height < 160) return null;
  return {
    x,
    width,
    y: gap,
    height,
  } as const;
}
