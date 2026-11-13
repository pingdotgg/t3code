import { useEffect, useRef } from "react";
import { GestureStateManager, PointerType, usePanGesture } from "react-native-gesture-handler";
import { runOnJS, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";

import {
  computeSwipeScrimOpacity,
  computeSwipeSidebarWidth,
  evaluateSwipeActivation,
  isInSystemEdgeExclusion,
  shouldCommitSidebarSwipe,
  SIDEBAR_FLOATING_SCRIM_OPACITY,
  type SidebarSwipeCapabilities,
  type SidebarSwipeDirection,
} from "./sidebar-swipe";
import { WORKSPACE_PANE_TIMING } from "./workspace-pane-animation";

interface SwipeConfigSnapshot {
  readonly canOpen: boolean;
  readonly canClose: boolean;
  readonly viewportWidth: number;
  readonly safeAreaLeft: number;
  readonly safeAreaRight: number;
  readonly maxWidth: number;
  readonly sidebarFloats: boolean;
  readonly primarySidebarVisible: boolean;
}

interface SwipeDragState {
  readonly tracking: boolean;
  readonly active: boolean;
  readonly direction: SidebarSwipeDirection | null;
  readonly touchStartX: number;
  readonly touchStartY: number;
  readonly activationX: number;
  readonly startWidth: number;
}

const IDLE_DRAG_STATE: SwipeDragState = {
  tracking: false,
  active: false,
  direction: null,
  touchStartX: 0,
  touchStartY: 0,
  activationX: 0,
  startWidth: 0,
};

interface UseSidebarSwipePanOptions {
  readonly canOpen: boolean;
  readonly canClose: boolean;
  readonly viewportWidth: number;
  readonly safeAreaLeft: number;
  readonly safeAreaRight: number;
  readonly maxWidth: number;
  readonly sidebarFloats: boolean;
  readonly primarySidebarVisible: boolean;
  readonly renderedSidebarWidth: SharedValue<number>;
  readonly scrimOpacity: SharedValue<number>;
  readonly onCommitVisibility: (visible: boolean) => void;
}

function snapBackToCommittedVisibility(
  cfg: SwipeConfigSnapshot,
  renderedSidebarWidth: SharedValue<number>,
  scrimOpacity: SharedValue<number>,
) {
  "worklet";
  renderedSidebarWidth.set(
    withTiming(cfg.primarySidebarVisible ? cfg.maxWidth : 0, WORKSPACE_PANE_TIMING),
  );
  if (cfg.sidebarFloats) {
    scrimOpacity.set(
      withTiming(
        cfg.primarySidebarVisible ? SIDEBAR_FLOATING_SCRIM_OPACITY : 0,
        WORKSPACE_PANE_TIMING,
      ),
    );
  }
}

function useSidebarSwipePanGesture(options: UseSidebarSwipePanOptions) {
  const {
    canOpen,
    canClose,
    viewportWidth,
    safeAreaLeft,
    safeAreaRight,
    maxWidth,
    sidebarFloats,
    primarySidebarVisible,
    renderedSidebarWidth,
    scrimOpacity,
    onCommitVisibility,
  } = options;

  const commitRef = useRef(onCommitVisibility);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the latest React visibility commit callback reachable from stable UI worklet callbacks
  useEffect(() => {
    commitRef.current = onCommitVisibility;
  }, [onCommitVisibility]);

  const commitVisibility = (visible: boolean) => {
    commitRef.current(visible);
  };

  const config = useSharedValue<SwipeConfigSnapshot>({
    canOpen,
    canClose,
    viewportWidth,
    safeAreaLeft,
    safeAreaRight,
    maxWidth,
    sidebarFloats,
    primarySidebarVisible,
  });
  const drag = useSharedValue<SwipeDragState>(IDLE_DRAG_STATE);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- syncs committed layout dimensions and swipe permissions into the UI-thread gesture worklet
  useEffect(() => {
    config.set({
      canOpen,
      canClose,
      viewportWidth,
      safeAreaLeft,
      safeAreaRight,
      maxWidth,
      sidebarFloats,
      primarySidebarVisible,
    });
  }, [
    canClose,
    canOpen,
    config,
    maxWidth,
    primarySidebarVisible,
    safeAreaLeft,
    safeAreaRight,
    sidebarFloats,
    viewportWidth,
  ]);

  return usePanGesture({
    enabled: canOpen || canClose,
    manualActivation: true,
    maxPointers: 1,
    onTouchesDown: (event) => {
      "worklet";
      const cfg = config.get();
      const touch = event.allTouches[0] ?? event.changedTouches[0];
      if (
        (!cfg.canOpen && !cfg.canClose) ||
        cfg.maxWidth <= 0 ||
        event.pointerType === PointerType.MOUSE ||
        event.numberOfTouches !== 1 ||
        !touch ||
        isInSystemEdgeExclusion(
          touch.absoluteX,
          cfg.viewportWidth,
          cfg.safeAreaLeft,
          cfg.safeAreaRight,
        )
      ) {
        drag.set(IDLE_DRAG_STATE);
        GestureStateManager.fail(event.handlerTag);
        return;
      }

      drag.set({
        tracking: true,
        active: false,
        direction: null,
        touchStartX: touch.absoluteX,
        touchStartY: touch.absoluteY,
        activationX: 0,
        startWidth: 0,
      });
    },
    onTouchesMove: (event) => {
      "worklet";
      const current = drag.get();
      if (!current.tracking || current.active) {
        return;
      }
      const touch = event.allTouches[0] ?? event.changedTouches[0];
      if (event.numberOfTouches !== 1 || !touch) {
        drag.set(IDLE_DRAG_STATE);
        GestureStateManager.fail(event.handlerTag);
        return;
      }

      const cfg = config.get();
      const decision = evaluateSwipeActivation({
        dx: touch.absoluteX - current.touchStartX,
        dy: touch.absoluteY - current.touchStartY,
        canOpen: cfg.canOpen,
        canClose: cfg.canClose,
      });
      if (decision === "fail") {
        drag.set(IDLE_DRAG_STATE);
        GestureStateManager.fail(event.handlerTag);
        return;
      }
      if (decision === "activate-open" || decision === "activate-close") {
        drag.set({
          ...current,
          tracking: false,
          direction: decision === "activate-open" ? "open" : "close",
        });
        GestureStateManager.activate(event.handlerTag);
      }
    },
    onActivate: (event) => {
      "worklet";
      const current = drag.get();
      if (current.direction === null) {
        return;
      }
      drag.set({
        ...current,
        tracking: false,
        active: true,
        activationX: event.absoluteX,
        startWidth: renderedSidebarWidth.get(),
      });
    },
    onUpdate: (event) => {
      "worklet";
      const current = drag.get();
      if (!current.active) {
        return;
      }
      const cfg = config.get();
      const nextWidth = computeSwipeSidebarWidth({
        startWidth: current.startWidth,
        translationX: event.absoluteX - current.activationX,
        maxWidth: cfg.maxWidth,
      });
      renderedSidebarWidth.set(nextWidth);
      if (cfg.sidebarFloats) {
        scrimOpacity.set(computeSwipeScrimOpacity(nextWidth, cfg.maxWidth));
      }
    },
    onDeactivate: (event) => {
      "worklet";
      const current = drag.get();
      const cfg = config.get();
      const direction = current.direction;
      const currentWidth = renderedSidebarWidth.get();
      drag.set(IDLE_DRAG_STATE);
      if (!current.active || direction === null) {
        return;
      }

      const nextVisible = event.canceled
        ? cfg.primarySidebarVisible
        : shouldCommitSidebarSwipe({
            direction,
            startWidth: current.startWidth,
            currentWidth,
            maxWidth: cfg.maxWidth,
            velocityX: event.velocityX,
          });

      if (nextVisible === cfg.primarySidebarVisible) {
        snapBackToCommittedVisibility(cfg, renderedSidebarWidth, scrimOpacity);
        return;
      }

      runOnJS(commitVisibility)(nextVisible);
    },
    onFinalize: () => {
      "worklet";
      const current = drag.get();
      if (current.active) {
        snapBackToCommittedVisibility(config.get(), renderedSidebarWidth, scrimOpacity);
      }
      drag.set(IDLE_DRAG_STATE);
    },
  });
}

export interface UseSidebarSwipeGesturesOptions {
  readonly capabilities: SidebarSwipeCapabilities;
  readonly viewportWidth: number;
  readonly safeAreaLeft: number;
  readonly safeAreaRight: number;
  readonly sidebarSlotWidth: number;
  readonly sidebarFloats: boolean;
  readonly primarySidebarVisible: boolean;
  readonly renderedSidebarWidth: SharedValue<number>;
  readonly scrimOpacity: SharedValue<number>;
  readonly onCommitVisibility: (visible: boolean) => void;
}

export function useSidebarSwipeGestures(options: UseSidebarSwipeGesturesOptions) {
  const { capabilities, sidebarSlotWidth, ...shared } = options;

  const contentSwipeGesture = useSidebarSwipePanGesture({
    ...shared,
    maxWidth: sidebarSlotWidth,
    canOpen: capabilities.canOpenContent,
    canClose: capabilities.canCloseContent,
  });

  const scrimSwipeGesture = useSidebarSwipePanGesture({
    ...shared,
    maxWidth: sidebarSlotWidth,
    canOpen: false,
    canClose: capabilities.canCloseScrim,
  });

  return { contentSwipeGesture, scrimSwipeGesture };
}
