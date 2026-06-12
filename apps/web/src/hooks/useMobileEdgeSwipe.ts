import { useEffect, useRef } from "react";

export type MobileEdgeSwipeSide = "left" | "right";
export type MobileEdgeSwipeStartArea = "edge" | "screen";
export type MobileEdgeSwipeStartSurface = "any" | "outside-panels" | "panel";
export type MobileEdgeSwipeAction = "close" | "open";

export const MOBILE_EDGE_SWIPE_EDGE_WIDTH_PX = 64;
export const MOBILE_EDGE_SWIPE_TRIGGER_DISTANCE_PX = 56;
export const MOBILE_EDGE_SWIPE_VERTICAL_CANCEL_DISTANCE_PX = 18;
export const MOBILE_EDGE_SWIPE_HORIZONTAL_DOMINANCE_RATIO = 1.25;
export const MOBILE_EDGE_SWIPE_OPEN_INTENT_TIMEOUT_MS = 350;
export const MOBILE_EDGE_SWIPE_PANEL_ATTRIBUTE = "data-mobile-edge-swipe-panel";
// Mark a subtree where a horizontal drag should scroll content (e.g. markdown
// code blocks and inline code) instead of opening or dismissing a panel. The
// swipe is only suppressed while the marked element can actually scroll
// horizontally; a snippet that fits lets the edge swipe through (see
// isBlockedTarget).
export const MOBILE_EDGE_SWIPE_BLOCK_ATTRIBUTE = "data-mobile-edge-swipe-block";

// A quick horizontal flick can trigger the action well before the sustained
// drag distance is reached. This lets the gesture win over a scrollable body,
// which otherwise cancels the swipe (via native scroll + touchcancel) before
// the slower distance threshold is met. A flick still has to clear a small
// distance and stay horizontally dominant so it does not fire on taps or
// vertical scrolls.
export const MOBILE_EDGE_SWIPE_FLICK_DISTANCE_PX = 24;
export const MOBILE_EDGE_SWIPE_FLICK_VELOCITY_PX_PER_MS = 0.5;
export const MOBILE_EDGE_SWIPE_SCROLL_EDGE_EPSILON_PX = 1;

export type MobileEdgeSwipeDecision = "cancel" | MobileEdgeSwipeAction | "pending";
export type MobileEdgeSwipeBlocker =
  | { readonly kind: "none" }
  | { readonly element: Element; readonly kind: "hard-block" }
  | { readonly element: HTMLElement; readonly kind: "horizontal-scroll-owner" };
export type HorizontalScrollOwnerSwipeDecision =
  | "allow-panel-swipe"
  | "cancel-panel-swipe"
  | "pending";

export interface MobileEdgeSwipeDelta {
  readonly action?: MobileEdgeSwipeAction;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly elapsedMs?: number;
  readonly side: MobileEdgeSwipeSide;
  /**
   * Instantaneous horizontal velocity (px/ms, signed like `deltaX`) sampled
   * from the most recent move. Used to recognize quick flicks.
   */
  readonly velocityX?: number;
}

function getOpeningDistance(side: MobileEdgeSwipeSide, deltaX: number): number {
  return side === "left" ? deltaX : -deltaX;
}

function getActionDistance({
  action = "open",
  deltaX,
  side,
}: {
  readonly action?: MobileEdgeSwipeAction;
  readonly deltaX: number;
  readonly side: MobileEdgeSwipeSide;
}): number {
  const openingDistance = getOpeningDistance(side, deltaX);
  return action === "open" ? openingDistance : -openingDistance;
}

function getActionVelocity({
  action = "open",
  side,
  velocityX,
}: {
  readonly action?: MobileEdgeSwipeAction;
  readonly side: MobileEdgeSwipeSide;
  readonly velocityX: number;
}): number {
  const openingVelocity = side === "left" ? velocityX : -velocityX;
  return action === "open" ? openingVelocity : -openingVelocity;
}

export function isMobileEdgeSwipeStart({
  edgeWidth = MOBILE_EDGE_SWIPE_EDGE_WIDTH_PX,
  startArea = "edge",
  viewportWidth,
  x,
  side,
}: {
  readonly edgeWidth?: number;
  readonly startArea?: MobileEdgeSwipeStartArea;
  readonly viewportWidth: number;
  readonly x: number;
  readonly side: MobileEdgeSwipeSide;
}): boolean {
  if (startArea === "screen") {
    return x >= 0 && x <= viewportWidth;
  }

  return side === "left" ? x <= edgeWidth : viewportWidth - x <= edgeWidth;
}

export function resolveMobileEdgeSwipeDecision({
  action = "open",
  deltaX,
  deltaY,
  elapsedMs,
  side,
  velocityX = 0,
}: MobileEdgeSwipeDelta): MobileEdgeSwipeDecision {
  const horizontalDistance = Math.abs(deltaX);
  const verticalDistance = Math.abs(deltaY);
  const actionDistance = getActionDistance({ action, deltaX, side });
  const actionVelocity = getActionVelocity({ action, side, velocityX });
  const isHorizontallyDominant =
    horizontalDistance >= verticalDistance * MOBILE_EDGE_SWIPE_HORIZONTAL_DOMINANCE_RATIO;

  // Quick flick in the action direction: trigger before the sustained drag
  // distance, while still requiring horizontal dominance so fast vertical
  // scrolling with incidental sideways motion does not open or close a panel.
  if (
    actionDistance >= MOBILE_EDGE_SWIPE_FLICK_DISTANCE_PX &&
    actionVelocity >= MOBILE_EDGE_SWIPE_FLICK_VELOCITY_PX_PER_MS &&
    isHorizontallyDominant
  ) {
    return action;
  }

  if (actionDistance >= MOBILE_EDGE_SWIPE_TRIGGER_DISTANCE_PX && isHorizontallyDominant) {
    if (
      action === "open" &&
      elapsedMs != null &&
      elapsedMs > MOBILE_EDGE_SWIPE_OPEN_INTENT_TIMEOUT_MS
    ) {
      return "cancel";
    }

    return action;
  }

  if (
    verticalDistance >= MOBILE_EDGE_SWIPE_VERTICAL_CANCEL_DISTANCE_PX &&
    !isHorizontallyDominant
  ) {
    return "cancel";
  }

  // Reuse the cancel threshold as an opposite-direction dead zone once the drag
  // has moved meaningfully away from the requested panel action.
  if (actionDistance <= -MOBILE_EDGE_SWIPE_VERTICAL_CANCEL_DISTANCE_PX) {
    return "cancel";
  }

  return "pending";
}

export function hasActiveTextSelection(
  selection: Pick<Selection, "isCollapsed" | "rangeCount"> | null | undefined,
): boolean {
  return Boolean(selection && selection.rangeCount > 0 && !selection.isCollapsed);
}

function isDomNode(value: EventTarget | null | undefined): value is Node {
  return typeof Node !== "undefined" && value instanceof Node;
}

function isShadowRoot(value: unknown): value is ShadowRoot {
  return typeof ShadowRoot !== "undefined" && value instanceof ShadowRoot;
}

function pushElementPath(elements: Element[], seen: Set<Element>, element: Element | null): void {
  let current: Element | null = element;
  while (current) {
    if (!seen.has(current)) {
      elements.push(current);
      seen.add(current);
    }

    if (current.parentElement) {
      current = current.parentElement;
      continue;
    }

    const root = current.getRootNode();
    current = isShadowRoot(root) && root.host instanceof Element ? root.host : null;
  }
}

function getElementPath(
  target: EventTarget | null,
  composedPath?: readonly EventTarget[],
): Element[] {
  const elements: Element[] = [];
  const seen = new Set<Element>();

  for (const pathTarget of composedPath ?? []) {
    if (pathTarget instanceof Element && !seen.has(pathTarget)) {
      elements.push(pathTarget);
      seen.add(pathTarget);
    }
  }

  if (target instanceof Element) {
    pushElementPath(elements, seen, target);
  } else if (isDomNode(target) && target.parentElement) {
    pushElementPath(elements, seen, target.parentElement);
  }

  return elements;
}

// An element owns the horizontal axis for a touch when it can actually scroll
// horizontally: its content overflows and overflow-x permits scrolling. A drag
// that starts here should scroll the content, never open or close a panel; the
// same intent the diff/chip CSS already expresses with overscroll-behavior-x.
function isHorizontallyScrollable(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) {
    return false;
  }
  if (el.scrollWidth <= el.clientWidth) {
    return false;
  }
  if (el.getAttribute(MOBILE_EDGE_SWIPE_BLOCK_ATTRIBUTE) === "true") {
    return true;
  }
  const overflowX = getComputedStyle(el).overflowX;
  return overflowX === "auto" || overflowX === "scroll" || overflowX === "overlay";
}

export function resolveMobileEdgeSwipeBlocker(
  target: EventTarget | null,
  composedPath?: readonly EventTarget[],
): MobileEdgeSwipeBlocker {
  for (const el of getElementPath(target, composedPath)) {
    // Inputs, terminals, and editable regions always swallow a horizontal drag.
    if (el.matches("input, textarea, select, [contenteditable='true'], .xterm")) {
      return { element: el, kind: "hard-block" };
    }
    // Anything that can scroll horizontally (diffs, code blocks, chip strips,
    // explicitly marked snippets) owns the gesture so a fast scroll is never
    // mistaken for a panel swipe. Content that fits has nothing to scroll, so
    // the edge swipe passes through and opens/closes the panel as usual.
    if (isHorizontallyScrollable(el)) {
      return { element: el, kind: "horizontal-scroll-owner" };
    }
  }

  return { kind: "none" };
}

export function isBlockedTarget(target: EventTarget | null): boolean {
  return resolveMobileEdgeSwipeBlocker(target).kind !== "none";
}

export function isScrollPositionAtStart(
  scrollPosition: number,
  tolerance = MOBILE_EDGE_SWIPE_SCROLL_EDGE_EPSILON_PX,
): boolean {
  return scrollPosition <= tolerance;
}

function isVerticallyScrollable(element: HTMLElement): boolean {
  return element.scrollHeight > element.clientHeight + MOBILE_EDGE_SWIPE_SCROLL_EDGE_EPSILON_PX;
}

function findNearestVerticalScrollableElement(target: EventTarget | null): HTMLElement | null {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return null;
  }

  for (let element: Element | null = target; element; element = element.parentElement) {
    if (
      typeof HTMLElement !== "undefined" &&
      element instanceof HTMLElement &&
      isVerticallyScrollable(element)
    ) {
      return element;
    }

    if (element.hasAttribute(MOBILE_EDGE_SWIPE_PANEL_ATTRIBUTE)) {
      return null;
    }
  }

  return null;
}

export function isNearestVerticalScrollableAtStart(
  target: EventTarget | null,
  tolerance = MOBILE_EDGE_SWIPE_SCROLL_EDGE_EPSILON_PX,
): boolean {
  const scrollable = findNearestVerticalScrollableElement(target);
  return scrollable === null || isScrollPositionAtStart(scrollable.scrollTop, tolerance);
}

function findSwipePanel(
  target: EventTarget | null,
  composedPath?: readonly EventTarget[],
): HTMLElement | null {
  for (const el of getElementPath(target, composedPath)) {
    if (el instanceof HTMLElement && el.getAttribute(MOBILE_EDGE_SWIPE_PANEL_ATTRIBUTE) !== null) {
      return el;
    }

    const panel = el.closest<HTMLElement>(`[${MOBILE_EDGE_SWIPE_PANEL_ATTRIBUTE}]`);
    if (panel) {
      return panel;
    }
  }

  return null;
}

function isAcceptedStartSurface({
  composedPath,
  side,
  startSurface,
  target,
}: {
  readonly composedPath?: readonly EventTarget[];
  readonly side: MobileEdgeSwipeSide;
  readonly startSurface: MobileEdgeSwipeStartSurface;
  readonly target: EventTarget | null;
}): boolean {
  if (startSurface === "any") {
    return true;
  }

  const panel = findSwipePanel(target, composedPath);
  if (startSurface === "outside-panels") {
    return panel === null;
  }

  return panel?.getAttribute(MOBILE_EDGE_SWIPE_PANEL_ATTRIBUTE) === side;
}

export function resolveHorizontalScrollOwnerSwipeDecision({
  action = "open",
  deltaX,
  edgeEpsilon = MOBILE_EDGE_SWIPE_SCROLL_EDGE_EPSILON_PX,
  side,
  startMaxScrollLeft,
  startScrollLeft,
  startSurface = "any",
}: {
  readonly action?: MobileEdgeSwipeAction;
  readonly deltaX: number;
  readonly edgeEpsilon?: number;
  readonly side: MobileEdgeSwipeSide;
  readonly startMaxScrollLeft: number;
  readonly startScrollLeft: number;
  readonly startSurface?: MobileEdgeSwipeStartSurface;
}): HorizontalScrollOwnerSwipeDecision {
  if (action !== "close" || startSurface !== "panel") {
    return "cancel-panel-swipe";
  }

  if (getActionDistance({ action, deltaX, side }) <= 0) {
    return "pending";
  }

  if (side === "right") {
    return startScrollLeft <= edgeEpsilon ? "allow-panel-swipe" : "cancel-panel-swipe";
  }

  return startScrollLeft >= startMaxScrollLeft - edgeEpsilon
    ? "allow-panel-swipe"
    : "cancel-panel-swipe";
}

function hasOpenSwipePanel(side: MobileEdgeSwipeSide): boolean {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`[${MOBILE_EDGE_SWIPE_PANEL_ATTRIBUTE}="${side}"]`),
  ).some((panel) => !panel.hidden);
}

export function useMobileEdgeSwipe({
  action = "open",
  blockedByOpenPanelSide,
  edgeWidth = MOBILE_EDGE_SWIPE_EDGE_WIDTH_PX,
  enabled,
  onSwipe,
  requireScrollableStartPosition = false,
  side,
  startArea = "edge",
  startSurface = "any",
}: {
  readonly action?: MobileEdgeSwipeAction;
  readonly blockedByOpenPanelSide?: MobileEdgeSwipeSide;
  readonly edgeWidth?: number;
  readonly enabled: boolean;
  readonly onSwipe: () => void;
  readonly requireScrollableStartPosition?: boolean;
  readonly side: MobileEdgeSwipeSide;
  readonly startArea?: MobileEdgeSwipeStartArea;
  readonly startSurface?: MobileEdgeSwipeStartSurface;
}) {
  const onSwipeRef = useRef(onSwipe);
  onSwipeRef.current = onSwipe;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    let activeSwipe: {
      id: number;
      source: "pointer" | "touch";
      horizontalScrollOwner?: {
        readonly startMaxScrollLeft: number;
        readonly startScrollLeft: number;
      };
      startTime: number;
      startX: number;
      startY: number;
      lastTime: number;
      lastX: number;
    } | null = null;
    let ignorePointerUntil = 0;

    const startSwipe = ({
      blocker,
      composedPath,
      id,
      source,
      startX,
      startY,
      target,
    }: {
      readonly blocker: MobileEdgeSwipeBlocker;
      readonly composedPath?: readonly EventTarget[];
      readonly id: number;
      readonly source: "pointer" | "touch";
      readonly startX: number;
      readonly startY: number;
      readonly target: EventTarget | null;
    }) => {
      if (
        hasActiveTextSelection(window.getSelection()) ||
        (blockedByOpenPanelSide !== undefined && hasOpenSwipePanel(blockedByOpenPanelSide)) ||
        !isAcceptedStartSurface({
          ...(composedPath ? { composedPath } : {}),
          side,
          startSurface,
          target,
        }) ||
        (requireScrollableStartPosition && !isNearestVerticalScrollableAtStart(target)) ||
        !isMobileEdgeSwipeStart({
          edgeWidth,
          side,
          startArea,
          viewportWidth: window.innerWidth,
          x: startX,
        })
      ) {
        return;
      }

      const now = performance.now();
      activeSwipe = {
        id,
        source,
        ...(blocker.kind === "horizontal-scroll-owner"
          ? {
              horizontalScrollOwner: {
                startMaxScrollLeft: Math.max(
                  0,
                  blocker.element.scrollWidth - blocker.element.clientWidth,
                ),
                startScrollLeft: blocker.element.scrollLeft,
              },
            }
          : {}),
        startTime: now,
        startX,
        startY,
        lastTime: now,
        lastX: startX,
      };
    };

    const updateSwipe = ({
      clientX,
      clientY,
      preventDefault,
    }: {
      readonly clientX: number;
      readonly clientY: number;
      readonly preventDefault: () => void;
    }) => {
      if (!activeSwipe) {
        return;
      }

      if (hasActiveTextSelection(window.getSelection())) {
        activeSwipe = null;
        return;
      }

      const now = performance.now();
      const deltaX = clientX - activeSwipe.startX;
      const deltaY = clientY - activeSwipe.startY;

      if (activeSwipe.horizontalScrollOwner) {
        const scrollOwnerDecision = resolveHorizontalScrollOwnerSwipeDecision({
          action,
          deltaX,
          side,
          startMaxScrollLeft: activeSwipe.horizontalScrollOwner.startMaxScrollLeft,
          startScrollLeft: activeSwipe.horizontalScrollOwner.startScrollLeft,
          startSurface,
        });
        if (scrollOwnerDecision === "cancel-panel-swipe") {
          activeSwipe = null;
          return;
        }
      }

      const sampleMs = now - activeSwipe.lastTime;
      const velocityX = sampleMs > 0 ? (clientX - activeSwipe.lastX) / sampleMs : 0;
      activeSwipe.lastTime = now;
      activeSwipe.lastX = clientX;

      const decision = resolveMobileEdgeSwipeDecision({
        deltaX,
        deltaY,
        elapsedMs: now - activeSwipe.startTime,
        action,
        side,
        velocityX,
      });

      if (decision === "pending") {
        return;
      }

      activeSwipe = null;
      if (decision === action) {
        preventDefault();
        onSwipeRef.current();
      }
    };

    const resetSwipe = () => {
      activeSwipe = null;
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        return;
      }

      const composedPath = event.composedPath();
      const blocker = resolveMobileEdgeSwipeBlocker(event.target, composedPath);
      if (
        blocker.kind === "hard-block" ||
        (blocker.kind === "horizontal-scroll-owner" &&
          (action !== "close" || startSurface !== "panel"))
      ) {
        return;
      }

      const touch = event.touches[0];
      if (!touch) {
        return;
      }

      ignorePointerUntil = performance.now() + 700;
      startSwipe({
        blocker,
        composedPath,
        id: touch.identifier,
        source: "touch",
        startX: touch.clientX,
        startY: touch.clientY,
        target: event.target,
      });
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!activeSwipe || activeSwipe.source !== "touch") {
        return;
      }

      const touchId = activeSwipe.id;
      const touch = Array.from(event.changedTouches).find(
        (changedTouch) => changedTouch.identifier === touchId,
      );
      if (!touch) {
        return;
      }

      updateSwipe({
        clientX: touch.clientX,
        clientY: touch.clientY,
        preventDefault: () => event.preventDefault(),
      });
    };

    const handlePointerDown = (event: PointerEvent) => {
      const composedPath = event.composedPath();
      const blocker = resolveMobileEdgeSwipeBlocker(event.target, composedPath);
      if (
        performance.now() < ignorePointerUntil ||
        event.pointerType !== "touch" ||
        event.isPrimary === false ||
        blocker.kind === "hard-block" ||
        (blocker.kind === "horizontal-scroll-owner" &&
          (action !== "close" || startSurface !== "panel"))
      ) {
        return;
      }

      startSwipe({
        blocker,
        composedPath,
        id: event.pointerId,
        source: "pointer",
        startX: event.clientX,
        startY: event.clientY,
        target: event.target,
      });
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!activeSwipe || activeSwipe.source !== "pointer" || activeSwipe.id !== event.pointerId) {
        return;
      }

      updateSwipe({
        clientX: event.clientX,
        clientY: event.clientY,
        preventDefault: () => event.preventDefault(),
      });
    };

    window.addEventListener("touchstart", handleTouchStart, { capture: true, passive: true });
    window.addEventListener("touchmove", handleTouchMove, { capture: true, passive: false });
    window.addEventListener("touchend", resetSwipe, true);
    window.addEventListener("touchcancel", resetSwipe, true);
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("pointermove", handlePointerMove, { capture: true, passive: false });
    window.addEventListener("pointerup", resetSwipe, true);
    window.addEventListener("pointercancel", resetSwipe, true);

    return () => {
      window.removeEventListener("touchstart", handleTouchStart, true);
      window.removeEventListener("touchmove", handleTouchMove, true);
      window.removeEventListener("touchend", resetSwipe, true);
      window.removeEventListener("touchcancel", resetSwipe, true);
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", resetSwipe, true);
      window.removeEventListener("pointercancel", resetSwipe, true);
    };
  }, [
    action,
    blockedByOpenPanelSide,
    edgeWidth,
    enabled,
    requireScrollableStartPosition,
    side,
    startArea,
    startSurface,
  ]);
}
