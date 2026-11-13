/**
 * Pure gesture geometry and eligibility helpers for interactive workspace sidebar swipes.
 *
 * UI-thread helpers carry `"worklet";` so Reanimated/RNGH callbacks execute them synchronously
 * without crossing the JS bridge.
 */

export const SIDEBAR_FLOATING_SCRIM_OPACITY = 0.32;

/**
 * Reserve 48dp from both screen edges so Android predictive Back / Samsung One UI edge panels
 * and iOS screen-edge navigation gestures keep full priority.
 */
export const SIDEBAR_SWIPE_EDGE_EXCLUSION_DP = 48;
export const SIDEBAR_SWIPE_EDGE_SAFE_AREA_BUFFER_DP = 24;

/**
 * Exceeds Android's default 8dp scaledTouchSlop so inner horizontal scrollers (code blocks,
 * diff viewers, webviews) claim touches via requestDisallowInterceptTouchEvent before open activates.
 */
export const SIDEBAR_SWIPE_ACTIVATION_OFFSET_X_DP = 18;
export const SIDEBAR_SWIPE_VERTICAL_FAIL_OFFSET_DP = 14;
export const SIDEBAR_SWIPE_OPPOSITE_FAIL_OFFSET_DP = 12;
export const SIDEBAR_SWIPE_HORIZONTAL_DOMINANCE_RATIO = 1.8;

export const SIDEBAR_SWIPE_OPEN_PROGRESS_THRESHOLD = 0.35;
export const SIDEBAR_SWIPE_CLOSE_PROGRESS_THRESHOLD = 0.35;
export const SIDEBAR_SWIPE_FLICK_VELOCITY_X = 420;
export const SIDEBAR_SWIPE_FLICK_MIN_TRAVEL_DP = 16;

export type SidebarSwipeDirection = "open" | "close";

export type SidebarSwipeActivationDecision =
  | "pending"
  | "activate-open"
  | "activate-close"
  | "fail";

export interface SidebarSwipeEligibilityInput {
  readonly usesSplitView: boolean;
  readonly nativeWorkspace: boolean;
  readonly workspacePage: boolean;
  readonly primarySidebarPinned: boolean;
  readonly primarySidebarVisible: boolean;
  readonly sidebarFloats: boolean;
  readonly railOverlay: boolean;
  readonly inspectorSheetOpen: boolean;
  readonly sidebarSlotWidth: number;
}

export interface SidebarSwipeCapabilities {
  readonly canOpenContent: boolean;
  readonly canCloseContent: boolean;
  readonly canCloseScrim: boolean;
}

export function deriveSidebarSwipeCapabilities(
  input: SidebarSwipeEligibilityInput,
): SidebarSwipeCapabilities {
  const eligible =
    input.usesSplitView &&
    !input.nativeWorkspace &&
    !input.workspacePage &&
    !input.primarySidebarPinned &&
    !input.railOverlay &&
    !input.inspectorSheetOpen &&
    input.sidebarSlotWidth > 0;

  if (!eligible) {
    return {
      canOpenContent: false,
      canCloseContent: false,
      canCloseScrim: false,
    };
  }

  return {
    canOpenContent: !input.primarySidebarVisible,
    canCloseContent: input.primarySidebarVisible && !input.sidebarFloats,
    canCloseScrim: input.primarySidebarVisible && input.sidebarFloats,
  };
}

export function computeEdgeExclusionBounds(
  viewportWidth: number,
  safeAreaLeft = 0,
  safeAreaRight = 0,
): { readonly left: number; readonly right: number } {
  "worklet";
  const leftInset = Number.isFinite(safeAreaLeft) ? Math.max(0, safeAreaLeft) : 0;
  const rightInset = Number.isFinite(safeAreaRight) ? Math.max(0, safeAreaRight) : 0;
  const left = Math.max(
    SIDEBAR_SWIPE_EDGE_EXCLUSION_DP,
    Math.ceil(leftInset) + SIDEBAR_SWIPE_EDGE_SAFE_AREA_BUFFER_DP,
  );
  const rightMargin = Math.max(
    SIDEBAR_SWIPE_EDGE_EXCLUSION_DP,
    Math.ceil(rightInset) + SIDEBAR_SWIPE_EDGE_SAFE_AREA_BUFFER_DP,
  );
  return {
    left,
    right: viewportWidth - rightMargin,
  };
}

export function isInSystemEdgeExclusion(
  windowX: number,
  viewportWidth: number,
  safeAreaLeft = 0,
  safeAreaRight = 0,
): boolean {
  "worklet";
  if (!Number.isFinite(windowX) || !Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return true;
  }
  const { left, right } = computeEdgeExclusionBounds(viewportWidth, safeAreaLeft, safeAreaRight);
  if (left >= right) {
    return true;
  }
  return windowX < left || windowX > right;
}

export function evaluateSwipeActivation(input: {
  readonly dx: number;
  readonly dy: number;
  readonly canOpen: boolean;
  readonly canClose: boolean;
}): SidebarSwipeActivationDecision {
  "worklet";
  const { dx, dy, canOpen, canClose } = input;
  if ((!canOpen && !canClose) || !Number.isFinite(dx) || !Number.isFinite(dy)) {
    return "fail";
  }

  const absDy = Math.abs(dy);
  if (absDy > SIDEBAR_SWIPE_VERTICAL_FAIL_OFFSET_DP) {
    return "fail";
  }

  if (dx > 0) {
    if (!canOpen) {
      return dx > SIDEBAR_SWIPE_OPPOSITE_FAIL_OFFSET_DP ? "fail" : "pending";
    }
    if (
      dx >= SIDEBAR_SWIPE_ACTIVATION_OFFSET_X_DP &&
      dx >= absDy * SIDEBAR_SWIPE_HORIZONTAL_DOMINANCE_RATIO
    ) {
      return "activate-open";
    }
    return "pending";
  }

  if (dx < 0) {
    const absDx = -dx;
    if (!canClose) {
      return absDx > SIDEBAR_SWIPE_OPPOSITE_FAIL_OFFSET_DP ? "fail" : "pending";
    }
    if (
      absDx >= SIDEBAR_SWIPE_ACTIVATION_OFFSET_X_DP &&
      absDx >= absDy * SIDEBAR_SWIPE_HORIZONTAL_DOMINANCE_RATIO
    ) {
      return "activate-close";
    }
    return "pending";
  }

  return "pending";
}

export function computeSwipeSidebarWidth(input: {
  readonly startWidth: number;
  readonly translationX: number;
  readonly maxWidth: number;
}): number {
  "worklet";
  if (!Number.isFinite(input.maxWidth) || input.maxWidth <= 0) {
    return 0;
  }
  const start = Number.isFinite(input.startWidth) ? input.startWidth : 0;
  const delta = Number.isFinite(input.translationX) ? input.translationX : 0;
  return Math.min(input.maxWidth, Math.max(0, start + delta));
}

export function computeSwipeScrimOpacity(sidebarWidth: number, maxWidth: number): number {
  "worklet";
  if (!Number.isFinite(maxWidth) || maxWidth <= 0 || !Number.isFinite(sidebarWidth)) {
    return 0;
  }
  const progress = Math.min(1, Math.max(0, sidebarWidth / maxWidth));
  return SIDEBAR_FLOATING_SCRIM_OPACITY * progress;
}

export function shouldCommitSidebarSwipe(input: {
  readonly direction: SidebarSwipeDirection;
  readonly startWidth: number;
  readonly currentWidth: number;
  readonly maxWidth: number;
  readonly velocityX: number;
}): boolean {
  "worklet";
  const { direction, startWidth, currentWidth, maxWidth } = input;
  const velocityX = Number.isFinite(input.velocityX) ? input.velocityX : 0;
  if (
    !Number.isFinite(maxWidth) ||
    maxWidth <= 0 ||
    !Number.isFinite(startWidth) ||
    !Number.isFinite(currentWidth)
  ) {
    return false;
  }

  if (direction === "open") {
    if (velocityX <= -SIDEBAR_SWIPE_FLICK_VELOCITY_X) {
      return false;
    }
    const openedEnough = currentWidth >= maxWidth * SIDEBAR_SWIPE_OPEN_PROGRESS_THRESHOLD;
    const flickedOpen =
      velocityX >= SIDEBAR_SWIPE_FLICK_VELOCITY_X &&
      currentWidth - startWidth >= SIDEBAR_SWIPE_FLICK_MIN_TRAVEL_DP;
    return openedEnough || flickedOpen;
  }

  if (velocityX >= SIDEBAR_SWIPE_FLICK_VELOCITY_X) {
    return true;
  }
  const closedEnough = currentWidth <= maxWidth * (1 - SIDEBAR_SWIPE_CLOSE_PROGRESS_THRESHOLD);
  const flickedClosed =
    velocityX <= -SIDEBAR_SWIPE_FLICK_VELOCITY_X &&
    startWidth - currentWidth >= SIDEBAR_SWIPE_FLICK_MIN_TRAVEL_DP;
  return !(closedEnough || flickedClosed);
}
