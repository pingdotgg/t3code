import { useCallback, useEffect, useMemo, useRef } from "react";
import { createComposerWidthValidator } from "../rightPanelLayout";

interface ResizeState {
  moved: boolean;
  pointerId: number;
  pendingWidth: number;
  startWidth: number;
  startX: number;
  rafId: number | null;
  width: number;
}

interface UseResizeHandleOptions {
  /** CSS custom property on the wrapper element that controls the panel width, e.g. "--plan-sidebar-width" */
  cssVarName: string;
  /** localStorage key for persisting the width across sessions */
  storageKey: string;
  /** Minimum allowed width in pixels */
  minWidth: number;
  /**
   * When true, any in-progress resize interaction is immediately cancelled and body
   * styles are cleaned up. Pass `shouldUsePlanSidebarSheet` here so that switching
   * to sheet mode mid-drag doesn't leave `cursor: col-resize` stuck on document.body.
   */
  isDisabled?: boolean;
}

/**
 * Encapsulates the pointer-event–based resize interaction for a right-side panel
 * rendered as a plain flex div (as opposed to the Sidebar component, which uses
 * position: fixed). Handles RAF-batched width updates, pointer capture, body style
 * management, click suppression, and localStorage persistence.
 */
export function useResizeHandle({
  cssVarName,
  storageKey,
  minWidth,
  isDisabled = false,
}: UseResizeHandleOptions) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const suppressClickRef = useRef(false);
  const resizeStateRef = useRef<ResizeState | null>(null);

  // Stable width validator — uses the same DOM-measurement logic as shouldAcceptInlineSidebarWidth
  const shouldAcceptWidth = useMemo(() => createComposerWidthValidator(cssVarName), [cssVarName]);

  const stop = useCallback(
    (pointerId: number) => {
      const state = resizeStateRef.current;
      if (!state) return;
      if (state.rafId !== null) cancelAnimationFrame(state.rafId);
      if (Number.isFinite(state.width)) {
        localStorage.setItem(storageKey, String(state.width));
      }
      resizeStateRef.current = null;
      if (handleRef.current?.hasPointerCapture(pointerId)) {
        handleRef.current.releasePointerCapture(pointerId);
      }
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [storageKey],
  );

  // When the panel switches to sheet mode mid-drag, clean up body styles immediately.
  // Without this, removing the drag handle from the DOM before onPointerUp fires leaves
  // cursor: col-resize and user-select: none stuck until ChatView unmounts.
  useEffect(() => {
    if (!isDisabled) return;
    const state = resizeStateRef.current;
    if (!state) return;
    stop(state.pointerId);
  }, [isDisabled, stop]);

  // Unmount cleanup
  useEffect(() => {
    return () => {
      const state = resizeStateRef.current;
      if (state?.rafId != null) cancelAnimationFrame(state.rafId);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
  }, []);

  /**
   * Callback ref for the wrapper element.
   * - On mount: restores the persisted width from localStorage, validated through
   *   `shouldAcceptWidth` so a stale value can't squeeze the composer below its
   *   minimum usable width (e.g. if the viewport is narrower than when it was saved).
   * - On unmount (node === null): cancels any active resize and clears body styles,
   *   covering the case where `planSidebarOpen` flips to false programmatically
   *   mid-drag (e.g. auto-close from plan state changes).
   */
  const setWrapperRef = useCallback(
    (node: HTMLDivElement | null) => {
      (wrapperRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      if (!node) {
        const state = resizeStateRef.current;
        if (state) stop(state.pointerId);
        return;
      }
      const stored = localStorage.getItem(storageKey);
      if (!stored) return;
      const parsed = Number(stored);
      if (!Number.isFinite(parsed) || parsed < minWidth) return;
      // Validate against current viewport/composer constraints before restoring.
      // shouldAcceptWidth temporarily sets the CSS var to measure then restores it,
      // so it's safe to call before we've applied the value ourselves.
      if (!shouldAcceptWidth({ nextWidth: parsed, wrapper: node })) return;
      node.style.setProperty(cssVarName, `${parsed}px`);
    },
    [cssVarName, storageKey, minWidth, stop, shouldAcceptWidth],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const startWidth = wrapper.getBoundingClientRect().width;
      const clamped = Math.max(minWidth, startWidth);
      wrapper.style.setProperty(cssVarName, `${clamped}px`);
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      resizeStateRef.current = {
        moved: false,
        pointerId: e.pointerId,
        pendingWidth: clamped,
        startWidth: clamped,
        startX: e.clientX,
        rafId: null,
        width: clamped,
      };
    },
    [cssVarName, minWidth],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const state = resizeStateRef.current;
      if (!state || state.pointerId !== e.pointerId) return;
      e.preventDefault();
      // Right-side panel: dragging left (decreasing clientX) makes it wider
      const delta = state.startX - e.clientX;
      if (Math.abs(delta) > 2) state.moved = true;
      state.pendingWidth = Math.max(minWidth, state.startWidth + delta);
      if (state.rafId !== null) return;
      state.rafId = requestAnimationFrame(() => {
        const s = resizeStateRef.current;
        const wrapper = wrapperRef.current;
        if (!s || !wrapper) return;
        s.rafId = null;
        const nextWidth = s.pendingWidth;
        if (!shouldAcceptWidth({ nextWidth, wrapper })) return;
        wrapper.style.setProperty(cssVarName, `${nextWidth}px`);
        s.width = nextWidth;
      });
    },
    [cssVarName, minWidth, shouldAcceptWidth],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const state = resizeStateRef.current;
      if (!state || state.pointerId !== e.pointerId) return;
      e.preventDefault();
      suppressClickRef.current = state.moved;
      stop(e.pointerId);
    },
    [stop],
  );

  const onClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      e.preventDefault();
    }
  }, []);

  return {
    handleRef,
    setWrapperRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onClick,
  };
}
