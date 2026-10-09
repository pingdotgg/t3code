import type { PreviewMiniPlayerFrame } from "../preview/previewMiniPlayerLayout";
import { DETAILS_CARD_CLEARANCE } from "./chatCanvasLayout";

/** Inset of the card from the canvas edges; the find bar shares it to line up. */
export const THREAD_DETAILS_CARD_GAP = 12;

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
  topInset = 0,
}: {
  container: { width: number; height: number };
  lane: { padding: number; minChatWidth: number };
  frame: PreviewMiniPlayerFrame | null;
  overlapsDetailsCard?: boolean;
  /** Space taken above the card, such as the open find bar. */
  topInset?: number;
}) {
  const gap = THREAD_DETAILS_CARD_GAP;
  // Keep in sync with --thread-details-panel-width, which sizes the popover.
  const width = 280;
  const x = container.width - width - gap;
  if (x - DETAILS_CARD_CLEARANCE - lane.padding < lane.minChatWidth) return null;
  const y = gap + topInset;
  // Resizing consumes the height above the player. Dragging first tries to
  // clear the full card and folds it only when there is no readable placement.
  const height =
    overlapsDetailsCard && frame && frame.x + frame.width > x - gap && frame.x < x + width + gap
      ? Math.min(container.height - y - gap, frame.y - y - gap)
      : container.height - y - gap;
  if (height < 160) return null;
  return {
    x,
    width,
    y,
    height,
  } as const;
}
