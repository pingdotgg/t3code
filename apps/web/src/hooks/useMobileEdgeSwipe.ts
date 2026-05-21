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

export type MobileEdgeSwipeDecision = "cancel" | MobileEdgeSwipeAction | "pending";

export interface MobileEdgeSwipeDelta {
  readonly action?: MobileEdgeSwipeAction;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly elapsedMs?: number;
  readonly side: MobileEdgeSwipeSide;
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
}: MobileEdgeSwipeDelta): MobileEdgeSwipeDecision {
  const horizontalDistance = Math.abs(deltaX);
  const verticalDistance = Math.abs(deltaY);
  const openingDistance = side === "left" ? deltaX : -deltaX;
  const actionDistance = action === "open" ? openingDistance : -openingDistance;

  if (
    verticalDistance >= MOBILE_EDGE_SWIPE_VERTICAL_CANCEL_DISTANCE_PX &&
    verticalDistance > horizontalDistance
  ) {
    return "cancel";
  }

  if (
    actionDistance >= MOBILE_EDGE_SWIPE_TRIGGER_DISTANCE_PX &&
    horizontalDistance >= verticalDistance * MOBILE_EDGE_SWIPE_HORIZONTAL_DOMINANCE_RATIO
  ) {
    if (
      action === "open" &&
      elapsedMs != null &&
      elapsedMs > MOBILE_EDGE_SWIPE_OPEN_INTENT_TIMEOUT_MS
    ) {
      return "cancel";
    }

    return action;
  }

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

function isBlockedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  return Boolean(
    target.closest(
      [
        "input",
        "textarea",
        "select",
        "[contenteditable='true']",
        "[data-mobile-edge-swipe-block='true']",
        ".xterm",
      ].join(","),
    ),
  );
}

function isAcceptedStartSurface({
  side,
  startSurface,
  target,
}: {
  readonly side: MobileEdgeSwipeSide;
  readonly startSurface: MobileEdgeSwipeStartSurface;
  readonly target: EventTarget | null;
}): boolean {
  if (startSurface === "any") {
    return true;
  }

  if (!(target instanceof Element)) {
    return startSurface === "outside-panels";
  }

  const panel = target.closest<HTMLElement>(`[${MOBILE_EDGE_SWIPE_PANEL_ATTRIBUTE}]`);
  if (startSurface === "outside-panels") {
    return panel === null;
  }

  return panel?.getAttribute(MOBILE_EDGE_SWIPE_PANEL_ATTRIBUTE) === side;
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
  side,
  startArea = "edge",
  startSurface = "any",
}: {
  readonly action?: MobileEdgeSwipeAction;
  readonly blockedByOpenPanelSide?: MobileEdgeSwipeSide;
  readonly edgeWidth?: number;
  readonly enabled: boolean;
  readonly onSwipe: () => void;
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

    let activeSwipe:
      | {
          pointerId: number;
          source: "pointer";
          startTime: number;
          startX: number;
          startY: number;
        }
      | {
          source: "touch";
          startTime: number;
          startX: number;
          startY: number;
          touchId: number;
        }
      | null = null;
    let ignorePointerUntil = 0;

    const startSwipe = ({
      id,
      source,
      startX,
      startY,
      target,
    }: {
      readonly id: number;
      readonly source: "pointer" | "touch";
      readonly startX: number;
      readonly startY: number;
      readonly target: EventTarget | null;
    }) => {
      if (
        hasActiveTextSelection(window.getSelection()) ||
        (blockedByOpenPanelSide !== undefined && hasOpenSwipePanel(blockedByOpenPanelSide)) ||
        !isAcceptedStartSurface({ side, startSurface, target }) ||
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

      activeSwipe =
        source === "pointer"
          ? { pointerId: id, source, startTime: performance.now(), startX, startY }
          : { source, startTime: performance.now(), startX, startY, touchId: id };
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

      const decision = resolveMobileEdgeSwipeDecision({
        deltaX: clientX - activeSwipe.startX,
        deltaY: clientY - activeSwipe.startY,
        elapsedMs: performance.now() - activeSwipe.startTime,
        action,
        side,
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
      if (event.touches.length !== 1 || isBlockedTarget(event.target)) {
        return;
      }

      const touch = event.touches[0];
      if (!touch) {
        return;
      }

      ignorePointerUntil = performance.now() + 700;
      startSwipe({
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

      const touchId = activeSwipe.touchId;
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
      if (
        performance.now() < ignorePointerUntil ||
        event.pointerType !== "touch" ||
        event.isPrimary === false ||
        isBlockedTarget(event.target)
      ) {
        return;
      }

      startSwipe({
        id: event.pointerId,
        source: "pointer",
        startX: event.clientX,
        startY: event.clientY,
        target: event.target,
      });
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (
        !activeSwipe ||
        activeSwipe.source !== "pointer" ||
        activeSwipe.pointerId !== event.pointerId
      ) {
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
  }, [action, blockedByOpenPanelSide, edgeWidth, enabled, side, startArea, startSurface]);
}
