export const WORKSPACE_SIDEBAR_SWIPE_DISTANCE = 72;
export const WORKSPACE_SIDEBAR_SWIPE_VELOCITY = 700;

/**
 * Only swipes that begin inside the left-edge band toggle the sidebar.
 * Horizontal content elsewhere (terminal, code blocks, diffs) scrolls on its
 * own; a pan left live across the whole pane would steal those gestures.
 */
export function shouldStartWorkspaceSidebarSwipe(startX: number): boolean {
  "worklet";
  return startX <= WORKSPACE_SIDEBAR_SWIPE_DISTANCE;
}

export function shouldToggleWorkspaceSidebarForSwipe(input: {
  readonly primarySidebarVisible: boolean;
  readonly translationX: number;
  readonly velocityX: number;
}): boolean {
  "worklet";

  const direction = input.primarySidebarVisible ? -1 : 1;

  return (
    input.translationX * direction >= WORKSPACE_SIDEBAR_SWIPE_DISTANCE ||
    input.velocityX * direction >= WORKSPACE_SIDEBAR_SWIPE_VELOCITY
  );
}
