// Minimum space between chat and the workspace card. Chat stays centered while
// the card fits beside it with this much room.
export const DETAILS_CARD_CLEARANCE = 32;

export interface ChatCanvasDetailsCard {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
}

/** Conversation and composer placement around the inline workspace card. */
export function resolveChatCanvasLayout({
  container,
  padding = 20,
  maxChatWidth = 768,
  detailsCard = null,
}: {
  container: { width: number; height: number };
  padding?: number;
  maxChatWidth?: number;
  detailsCard?: ChatCanvasDetailsCard | null;
}) {
  const centeredWidth = Math.max(0, Math.min(maxChatWidth, container.width - padding * 2));
  // A workspace card that does not fit beside the centered chat first moves
  // chat left, only as far as it needs. Chat narrows only after it reaches the
  // left padding.
  const laneRight = detailsCard
    ? detailsCard.left - DETAILS_CARD_CLEARANCE
    : container.width - padding;
  const normalWidth = Math.max(0, Math.min(centeredWidth, laneRight - padding));
  const normalLeft = Math.max(
    padding,
    Math.min((container.width - normalWidth) / 2, laneRight - normalWidth),
  );
  const chat = {
    left: normalLeft,
    width: normalWidth,
    insetStart: 0,
    insetEnd: Math.max(0, container.width - normalLeft * 2 - normalWidth),
  };
  return { chat };
}
