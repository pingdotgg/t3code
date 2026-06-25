"use client";

import type { PreviewViewportSetting, PreviewViewportSize } from "@t3tools/contracts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { commitBrowserViewportChange } from "./browserViewportActions";
import {
  browserViewportSettingKey,
  resizeBrowserViewportFromRail,
  resizeFreeformViewport,
  resolveBrowserDeviceViewportArea,
  resolveBrowserDeviceViewportLayout,
  resolveBrowserViewportLayout,
  type BrowserViewportResizeDirection,
} from "./browserViewportLayout";

interface ViewportDrag extends PreviewViewportSize {
  readonly sourceKey: string;
  readonly direction: BrowserViewportResizeDirection;
}

const KEYBOARD_RESIZE_COMMIT_DELAY_MS = 150;

export function useBrowserViewportResize(options: {
  readonly tabId: string;
  readonly viewport: PreviewViewportSetting;
  readonly zoomFactor: number;
  readonly containerSize: PreviewViewportSize;
  readonly deviceToolbarVisible: boolean;
  readonly aspectRatio: number | null;
}) {
  const { tabId, viewport, zoomFactor, containerSize, deviceToolbarVisible, aspectRatio } = options;
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const dragVersionRef = useRef(0);
  const keyboardCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardViewportRef = useRef<ViewportDrag | null>(null);
  const [dragViewport, setDragViewport] = useState<ViewportDrag | null>(null);
  const sourceViewportKey = browserViewportSettingKey(viewport);
  const sourceViewportKeyRef = useRef(sourceViewportKey);
  sourceViewportKeyRef.current = sourceViewportKey;
  const activeDrag = dragViewport?.sourceKey === sourceViewportKey ? dragViewport : null;
  const effectiveViewport = activeDrag
    ? ({
        _tag: "freeform",
        width: activeDrag.width,
        height: activeDrag.height,
      } as const satisfies PreviewViewportSetting)
    : viewport;
  const normalizedZoomFactor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const viewportContainerSize = deviceToolbarVisible
    ? resolveBrowserDeviceViewportArea(containerSize)
    : containerSize;
  const layout =
    deviceToolbarVisible && effectiveViewport._tag !== "fill"
      ? resolveBrowserDeviceViewportLayout(containerSize, effectiveViewport, zoomFactor)
      : resolveBrowserViewportLayout(containerSize, effectiveViewport, zoomFactor);

  useEffect(
    () => () => {
      dragVersionRef.current += 1;
      dragCleanupRef.current?.();
      if (keyboardCommitTimerRef.current !== null) {
        clearTimeout(keyboardCommitTimerRef.current);
      }
      keyboardCommitTimerRef.current = null;
      keyboardViewportRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const pending = keyboardViewportRef.current;
    if (!pending || pending.sourceKey === sourceViewportKey) return;
    if (keyboardCommitTimerRef.current !== null) {
      clearTimeout(keyboardCommitTimerRef.current);
      keyboardCommitTimerRef.current = null;
    }
    keyboardViewportRef.current = null;
  }, [sourceViewportKey]);

  const commitViewportChange = useCallback(
    (next: PreviewViewportSetting) => {
      dragVersionRef.current += 1;
      dragCleanupRef.current?.();
      if (keyboardCommitTimerRef.current !== null) {
        clearTimeout(keyboardCommitTimerRef.current);
        keyboardCommitTimerRef.current = null;
      }
      keyboardViewportRef.current = null;
      setDragViewport(null);
      return commitBrowserViewportChange(tabId, next);
    },
    [tabId],
  );

  const clearDrag = () => setDragViewport(null);
  const commitDrag = (next: PreviewViewportSetting) => {
    const version = ++dragVersionRef.current;
    const clearIfCurrent = () => {
      if (dragVersionRef.current === version) clearDrag();
    };
    void commitBrowserViewportChange(tabId, next).then(clearIfCurrent, clearIfCurrent);
  };

  const handleResizeKeyDown = (
    direction: BrowserViewportResizeDirection,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (effectiveViewport._tag === "fill") return;
    const controlsWidth = direction.includes("east") || direction.includes("west");
    const controlsHeight = direction.includes("north") || direction.includes("south");
    const step = (event.shiftKey ? 50 : 10) * normalizedZoomFactor;
    const delta =
      event.key === "ArrowLeft" && controlsWidth
        ? { x: -step, y: 0 }
        : event.key === "ArrowRight" && controlsWidth
          ? { x: step, y: 0 }
          : event.key === "ArrowUp" && controlsHeight
            ? { x: 0, y: -step }
            : event.key === "ArrowDown" && controlsHeight
              ? { x: 0, y: step }
              : null;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const pending = keyboardViewportRef.current;
    const base = pending?.sourceKey === sourceViewportKey ? pending : effectiveViewport;
    const next = resizeFreeformViewport(
      base,
      delta,
      zoomFactor,
      direction,
      aspectRatio ?? undefined,
    );
    if (next.width === base.width && next.height === base.height) return;
    const keyboardViewport = { sourceKey: sourceViewportKey, ...next, direction };
    keyboardViewportRef.current = keyboardViewport;
    setDragViewport(keyboardViewport);
    if (keyboardCommitTimerRef.current !== null) {
      clearTimeout(keyboardCommitTimerRef.current);
    }
    keyboardCommitTimerRef.current = setTimeout(() => {
      keyboardCommitTimerRef.current = null;
      const latest = keyboardViewportRef.current;
      if (!latest || latest.sourceKey !== sourceViewportKeyRef.current) return;
      keyboardViewportRef.current = null;
      commitDrag({ _tag: "freeform", width: latest.width, height: latest.height });
    }, KEYBOARD_RESIZE_COMMIT_DELAY_MS);
  };

  const handleResizePointerDown = (
    direction: BrowserViewportResizeDirection,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (effectiveViewport._tag === "fill") return;
    event.preventDefault();
    event.stopPropagation();
    if (keyboardCommitTimerRef.current !== null) {
      clearTimeout(keyboardCommitTimerRef.current);
      keyboardCommitTimerRef.current = null;
    }
    keyboardViewportRef.current = null;
    dragCleanupRef.current?.();
    dragVersionRef.current += 1;
    const pointerId = event.pointerId;
    const target = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = effectiveViewport.width;
    const startHeight = effectiveViewport.height;
    const dragZoomFactor = normalizedZoomFactor * layout.viewportScale;
    let latest = { width: startWidth, height: startHeight };
    setDragViewport({
      sourceKey: sourceViewportKey,
      width: startWidth,
      height: startHeight,
      direction,
    });
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Window listeners below keep the drag functional when capture is unavailable.
    }

    const sourceChanged = () => sourceViewportKeyRef.current !== sourceViewportKey;
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (sourceChanged()) {
        cleanup();
        dragVersionRef.current += 1;
        clearDrag();
        return;
      }
      moveEvent.preventDefault();
      const { width, height } = resizeBrowserViewportFromRail(
        { width: startWidth, height: startHeight },
        {
          x: moveEvent.clientX - startX,
          y: moveEvent.clientY - startY,
        },
        viewportContainerSize,
        dragZoomFactor,
        direction,
        aspectRatio ?? undefined,
      );
      latest = { width, height };
      setDragViewport({ sourceKey: sourceViewportKey, width, height, direction });
    };
    function cleanup() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      dragCleanupRef.current = null;
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        // The browser may already have released capture on pointerup.
      }
    }
    function finish(upEvent: PointerEvent) {
      if (upEvent.pointerId !== pointerId) return;
      cleanup();
      if (sourceChanged() || (latest.width === startWidth && latest.height === startHeight)) {
        clearDrag();
        return;
      }
      commitDrag({
        _tag: "freeform",
        width: latest.width,
        height: latest.height,
      });
    }
    function cancel(cancelEvent: PointerEvent) {
      if (cancelEvent.pointerId !== pointerId) return;
      cleanup();
      dragVersionRef.current += 1;
      clearDrag();
    }
    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  };

  return {
    activeDrag,
    commitViewportChange,
    effectiveViewport,
    handleResizeKeyDown,
    handleResizePointerDown,
    layout,
  };
}
