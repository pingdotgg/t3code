import type { PreviewMiniPlayerFrame } from "../preview/previewMiniPlayerLayout";

export function resolveThreadDetailsCardDensity(
  height: number,
  content: { full: number; compact: number },
) {
  if (content.full === 0 || content.full <= height) return "full";
  if (content.compact === 0 || content.compact <= height) return "compact";
  return "essential";
}

/** The card uses leftover space. It never changes the conversation's width. */
export function resolveThreadDetailsCardLayout({
  container,
  chat,
  frame,
  overlapsDetailsCard = false,
}: {
  container: { width: number; height: number };
  chat: { left: number; width: number };
  frame: PreviewMiniPlayerFrame | null;
  overlapsDetailsCard?: boolean;
}) {
  const gap = 12;
  const width = Math.min(312, container.width - chat.left - chat.width - gap * 2);
  if (width < 240) return null;
  const x = container.width - width - gap;
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
