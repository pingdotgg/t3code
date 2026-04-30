import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { DEFAULT_THREAD_TERMINAL_HEIGHT } from "./types";

export const MIN_BOTTOM_DRAWER_HEIGHT = 180;
export const MAX_BOTTOM_DRAWER_HEIGHT_RATIO = 0.75;

export function maxBottomDrawerHeight(): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(
    MIN_BOTTOM_DRAWER_HEIGHT,
    Math.floor(window.innerHeight * MAX_BOTTOM_DRAWER_HEIGHT_RATIO),
  );
}

export function clampBottomDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.min(
    Math.max(Math.round(safeHeight), MIN_BOTTOM_DRAWER_HEIGHT),
    maxBottomDrawerHeight(),
  );
}

export function resolveFullBottomDrawerHeight(topOffset: number | null | undefined): number {
  if (typeof window === "undefined") {
    return maxBottomDrawerHeight();
  }
  const safeTop =
    typeof topOffset === "number" && Number.isFinite(topOffset)
      ? Math.max(0, Math.round(topOffset))
      : 0;
  return Math.max(MIN_BOTTOM_DRAWER_HEIGHT, Math.floor(window.innerHeight - safeTop));
}

interface UseBottomDrawerSizingOptions {
  visible: boolean;
  height: number;
  fullHeight: boolean;
  onHeightChange: (height: number) => void;
  onFullHeightChange: (fullHeight: boolean) => void;
  onHeightSettled?: (() => void) | undefined;
  identityKey?: string | number | null | undefined;
}

export function useBottomDrawerSizing<TElement extends HTMLElement>({
  visible,
  height,
  fullHeight,
  onHeightChange,
  onFullHeightChange,
  onHeightSettled,
  identityKey,
}: UseBottomDrawerSizingOptions) {
  const drawerRef = useRef<TElement | null>(null);
  const [drawerHeight, setDrawerHeight] = useState(() => clampBottomDrawerHeight(height));
  const drawerHeightRef = useRef(drawerHeight);
  const lastSyncedHeightRef = useRef(clampBottomDrawerHeight(height));
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const syncHeight = useCallback((nextHeight: number) => {
    const clampedHeight = clampBottomDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === clampedHeight) {
      return;
    }
    lastSyncedHeightRef.current = clampedHeight;
    onHeightChangeRef.current(clampedHeight);
  }, []);

  const readFullHeight = useCallback(() => {
    const parentRect = drawerRef.current?.parentElement?.getBoundingClientRect();
    if (parentRect && Number.isFinite(parentRect.height) && parentRect.height > 0) {
      return Math.max(MIN_BOTTOM_DRAWER_HEIGHT, Math.floor(parentRect.height));
    }
    return resolveFullBottomDrawerHeight(drawerRef.current?.getBoundingClientRect().top);
  }, []);

  useEffect(() => {
    const nextHeight = fullHeight ? readFullHeight() : clampBottomDrawerHeight(height);
    setDrawerHeight(nextHeight);
    drawerHeightRef.current = nextHeight;
    if (!fullHeight) {
      lastSyncedHeightRef.current = nextHeight;
    }
  }, [fullHeight, height, identityKey, readFullHeight]);

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      didResizeDuringDragRef.current = false;

      if (fullHeight) {
        const nextHeight = clampBottomDrawerHeight(drawerHeightRef.current);
        onFullHeightChange(false);
        drawerHeightRef.current = nextHeight;
        setDrawerHeight(nextHeight);
        syncHeight(nextHeight);
      }

      resizeStateRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: drawerHeightRef.current,
      };
    },
    [fullHeight, onFullHeightChange, syncHeight],
  );

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const clampedHeight = clampBottomDrawerHeight(
      resizeState.startHeight + (resizeState.startY - event.clientY),
    );
    if (clampedHeight === drawerHeightRef.current) {
      return;
    }
    didResizeDuringDragRef.current = true;
    drawerHeightRef.current = clampedHeight;
    setDrawerHeight(clampedHeight);
  }, []);

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeDuringDragRef.current) {
        return;
      }
      syncHeight(drawerHeightRef.current);
      onHeightSettled?.();
    },
    [onHeightSettled, syncHeight],
  );

  useEffect(() => {
    if (!visible) {
      return;
    }

    const onWindowResize = () => {
      const nextHeight = fullHeight
        ? readFullHeight()
        : clampBottomDrawerHeight(drawerHeightRef.current);
      const changed = nextHeight !== drawerHeightRef.current;
      if (changed) {
        setDrawerHeight(nextHeight);
        drawerHeightRef.current = nextHeight;
      }
      if (!fullHeight && !resizeStateRef.current) {
        syncHeight(nextHeight);
      }
      onHeightSettled?.();
    };

    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, [fullHeight, onHeightSettled, readFullHeight, syncHeight, visible]);

  useEffect(() => {
    return () => {
      syncHeight(drawerHeightRef.current);
    };
  }, [syncHeight]);

  return {
    drawerRef,
    drawerHeight,
    handleResizePointerDown,
    handleResizePointerMove,
    handleResizePointerEnd,
  };
}
