import * as React from "react";
import * as Schema from "effect/Schema";

import { cn } from "~/lib/utils";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";

const DEFAULT_MIN_HEIGHT = 160;
// Dragging the handle more than this many pixels past the minimum height
// closes the dock (drag-to-dismiss), matching the sidebar rail gesture.
const CLOSE_OVERSHOOT = 64;

function clampHeight(height: number, minHeight: number, maxHeight: number): number {
  return Math.max(minHeight, Math.min(height, maxHeight));
}

/**
 * A bottom dock drawer that slides open/closed with the same 200ms offcanvas
 * easing as the left/right `Sidebar`, and exposes a top drag handle that
 * resizes the height and closes the dock when dragged past the minimum.
 *
 * Kept mounted (when `mounted`) so both open and close animate; the height is
 * persisted to `storageKey`.
 */
export function BottomDock(props: {
  open: boolean;
  mounted: boolean;
  children: React.ReactNode;
  onClose: () => void;
  storageKey: string;
  defaultHeight?: number;
  minHeight?: number;
  /** Max height as a fraction of the available viewport height. */
  maxHeightRatio?: number;
}) {
  const {
    open,
    mounted,
    children,
    onClose,
    storageKey,
    defaultHeight = 280,
    minHeight = DEFAULT_MIN_HEIGHT,
    maxHeightRatio = 0.75,
  } = props;

  const [height, setHeight] = React.useState<number>(() => {
    const stored = getLocalStorageItem(storageKey, Schema.Finite);
    return stored ?? defaultHeight;
  });

  const containerRef = React.useRef<HTMLElement | null>(null);
  const resizeStateRef = React.useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    height: number;
    willClose: boolean;
    handle: HTMLElement;
  } | null>(null);

  const maxHeight = React.useCallback(
    () => Math.max(minHeight, Math.round(window.innerHeight * maxHeightRatio)),
    [maxHeightRatio, minHeight],
  );

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startHeight = clampHeight(height, minHeight, maxHeight());
      resizeStateRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight,
        height: startHeight,
        willClose: false,
        handle: event.currentTarget,
      };
      // Disable the open/close transition while dragging so it tracks the cursor.
      if (containerRef.current) {
        containerRef.current.style.setProperty("transition-duration", "0ms");
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [height, maxHeight, minHeight],
  );

  const endResize = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const state = resizeStateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      event.preventDefault();
      if (containerRef.current) {
        containerRef.current.style.removeProperty("transition-duration");
      }
      if (state.handle.hasPointerCapture(event.pointerId)) {
        state.handle.releasePointerCapture(event.pointerId);
      }
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      const willClose = state.willClose;
      const finalHeight = state.height;
      resizeStateRef.current = null;
      if (willClose) {
        // Keep the pre-drag height stored so reopening uses a sensible size.
        setHeight(state.startHeight);
        onClose();
      } else {
        setHeight(finalHeight);
        setLocalStorageItem(storageKey, finalHeight, Schema.Finite);
      }
    },
    [onClose, storageKey],
  );

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const state = resizeStateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      event.preventDefault();
      // Drawer grows when dragging the top handle upward.
      const rawHeight = state.startHeight + (state.startY - event.clientY);
      // Collapse live the moment the drag crosses the close threshold.
      if (rawHeight < minHeight - CLOSE_OVERSHOOT) {
        state.willClose = true;
        endResize(event);
        return;
      }
      const next = clampHeight(rawHeight, minHeight, maxHeight());
      state.height = next;
      setHeight(next);
    },
    [endResize, maxHeight, minHeight],
  );

  React.useEffect(() => {
    return () => {
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
  }, []);

  if (!mounted) return null;

  return (
    <aside
      ref={containerRef}
      data-state={open ? "expanded" : "collapsed"}
      className={cn(
        "relative flex shrink-0 flex-col overflow-hidden border-t border-border bg-background",
        "transition-[height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[height] motion-reduce:transition-none",
      )}
      style={{ height: open ? `${height}px` : "0px" }}
    >
      {/* Top drag handle: resize + drag-to-close */}
      <button
        type="button"
        aria-label="Resize bottom panel"
        title="Drag to resize"
        className="absolute inset-x-0 top-0 z-20 h-2 -translate-y-1/2 cursor-row-resize bg-transparent after:absolute after:inset-x-0 after:top-1/2 after:h-[2px] after:-translate-y-1/2 hover:after:bg-sidebar-border"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </aside>
  );
}
