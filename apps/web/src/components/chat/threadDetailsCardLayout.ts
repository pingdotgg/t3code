import type { PreviewMiniPlayerFrame } from "../preview/previewMiniPlayerLayout";
import { DETAILS_CARD_CLEARANCE } from "./chatCanvasLayout";

export const THREAD_DETAILS_CARD_GAP = 12;
// The docked card is fixed; popovers and find bars use --thread-details-panel-width.
const THREAD_DETAILS_CARD_WIDTH = 272;
const THREAD_DETAILS_BOTTOM_GAP = 18;

export function resolveThreadDetailsCardDensity(
  height: number,
  content: { full: number; compact: number },
) {
  if (content.full === 0 || content.full <= height) return "full";
  if (content.compact === 0 || content.compact <= height) return "compact";
  return "essential";
}

/** Sections a squeezed inline card drops whole, the first to go first. */
export const THREAD_DETAILS_CUT_ORDER = [
  "cards",
  "usage",
  "scripts",
  "repositories",
  "pullRequests",
] as const;
export type ThreadDetailsCutUnit = (typeof THREAD_DETAILS_CUT_ORDER)[number];

/**
 * How many sections of THREAD_DETAILS_CUT_ORDER to drop so the rest and the reveal row fit.
 * Every height is the section's full one, cut or not, so the answer never feeds back into its input.
 */
export function resolveThreadDetailsCut(
  height: number,
  content: {
    readonly full: number;
    readonly slots: Partial<Record<ThreadDetailsCutUnit, number>>;
    readonly reveal: number;
  },
) {
  if (content.full <= height) return 0;
  let total = content.full + content.reveal;
  for (const [index, unit] of THREAD_DETAILS_CUT_ORDER.entries()) {
    if (total <= height) return index;
    total -= content.slots[unit] ?? 0;
  }
  return THREAD_DETAILS_CUT_ORDER.length;
}

export function resolveThreadDetailsCardLayout({
  container,
  narrowestWidth = container.width,
  lane,
  frame,
  overlapsDetailsCard = false,
  topInset = 0,
}: {
  container: { width: number; height: number };
  // While a panel animates the container, the card fits only if it fits at both ends.
  narrowestWidth?: number;
  lane: { padding: number; minChatWidth: number };
  frame: PreviewMiniPlayerFrame | null;
  overlapsDetailsCard?: boolean;
  topInset?: number;
}) {
  const gap = THREAD_DETAILS_CARD_GAP;
  const width = THREAD_DETAILS_CARD_WIDTH;
  const x = container.width - width - gap;
  // The transition ends are sampled once, so a resize mid-animation can leave them
  // wider than the container is now.
  const fitWidth = Math.min(narrowestWidth, container.width);
  if (fitWidth - width - gap - DETAILS_CARD_CLEARANCE - lane.padding < lane.minChatWidth)
    return null;
  const y = gap + topInset;
  const height =
    overlapsDetailsCard && frame && frame.x + frame.width > x - gap && frame.x < x + width + gap
      ? Math.min(container.height - y - THREAD_DETAILS_BOTTOM_GAP, frame.y - y - gap)
      : container.height - y - THREAD_DETAILS_BOTTOM_GAP;
  if (height < 160) return null;
  return {
    x,
    right: gap,
    width,
    y,
    height,
  } as const;
}
