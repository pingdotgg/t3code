export const SIDEBAR_SWIPE_ACTION_WIDTH = 72;

const SWIPE_INTENT_DISTANCE = 8;
const HORIZONTAL_INTENT_RATIO = 1.25;

export type SidebarSwipeIntent = "pending" | "horizontal" | "vertical";

/**
 * Bias ambiguous gestures toward vertical scrolling. A row only takes over
 * once the finger has moved clearly farther sideways than up or down.
 */
export function resolveSidebarSwipeIntent(deltaX: number, deltaY: number): SidebarSwipeIntent {
  const horizontalDistance = Math.abs(deltaX);
  const verticalDistance = Math.abs(deltaY);
  if (Math.max(horizontalDistance, verticalDistance) < SWIPE_INTENT_DISTANCE) return "pending";
  return horizontalDistance > verticalDistance * HORIZONTAL_INTENT_RATIO
    ? "horizontal"
    : "vertical";
}

export function clampSidebarSwipeOffset(input: {
  originOffset: number;
  deltaX: number;
  revealWidth: number;
}): number {
  const { originOffset, deltaX, revealWidth } = input;
  return Math.min(0, Math.max(-revealWidth, originOffset + deltaX));
}

/** A short deliberate pull opens the tray; a mostly closed row stays closed. */
export function shouldOpenSidebarSwipe(input: { offset: number; revealWidth: number }): boolean {
  return input.offset <= -input.revealWidth * 0.35;
}
