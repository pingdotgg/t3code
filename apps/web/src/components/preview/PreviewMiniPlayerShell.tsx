"use client";

import type { ScopedThreadRef } from "@t3tools/contracts";
import { GripIcon, PanelRightIcon, XIcon } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { BrowserViewportResizeDirection } from "~/browser/browserViewportLayout";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import {
  type PreviewMiniPlayerSize,
  type PreviewMiniPlayerSource,
  previewMiniPlayerSourceKey,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import {
  clampPreviewMiniPlayerPosition,
  PREVIEW_MINI_PLAYER_CORNER_RADIUS,
  type PreviewMiniPlayerFrame,
  resizePreviewMiniPlayer,
  resolvePreviewMiniPlayerFrame,
} from "./previewMiniPlayerLayout";

interface PointerGesture {
  readonly pointerId: number;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly frame: PreviewMiniPlayerFrame;
  readonly direction: BrowserViewportResizeDirection | null;
  moved: boolean;
}

// Ignore small pointer movement when pressing a control.
const GESTURE_SLOP_PX = 6;

const frameCornerRadius = () => PREVIEW_MINI_PLAYER_CORNER_RADIUS;

const RESIZE_CURSOR_CLASSES = {
  north: "cursor-ns-resize",
  south: "cursor-ns-resize",
  west: "cursor-ew-resize",
  east: "cursor-ew-resize",
  northwest: "cursor-nwse-resize",
  northeast: "cursor-nesw-resize",
  southwest: "cursor-nesw-resize",
  southeast: "cursor-nwse-resize",
} satisfies Record<BrowserViewportResizeDirection, string>;
const MOVE_DELTAS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

// Invisible grab zones straddling each edge; the cursor is the only affordance.
const RESIZE_HANDLES: ReadonlyArray<{
  readonly direction: BrowserViewportResizeDirection;
  readonly className: string;
}> = [
  { direction: "north", className: "inset-x-0 -top-1 h-2 cursor-ns-resize" },
  { direction: "south", className: "inset-x-0 -bottom-1 h-2 cursor-ns-resize" },
  { direction: "west", className: "inset-y-0 -left-1 w-2 cursor-ew-resize" },
  { direction: "east", className: "inset-y-0 -right-1 w-2 cursor-ew-resize" },
  { direction: "northwest", className: "-left-2 -top-2 size-4 cursor-nwse-resize" },
  { direction: "northeast", className: "-right-2 -top-2 size-4 cursor-nesw-resize" },
  { direction: "southwest", className: "-bottom-2 -left-2 size-4 cursor-nesw-resize" },
  { direction: "southeast", className: "-bottom-2 -right-2 size-4 cursor-nwse-resize" },
];

/**
 * The frame, drag/resize gestures, and controls shared by every floating
 * source. Native clipping and the DOM frame use the same radius so their
 * separately composited edges stay aligned.
 */
export function PreviewMiniPlayerShell({
  threadRef,
  source,
  sourceSize,
  label,
  onOpenInPanel,
  pillActions,
  recording = false,
  cornerRadius = frameCornerRadius,
  children,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly source: PreviewMiniPlayerSource;
  readonly sourceSize: PreviewMiniPlayerSize;
  readonly label: string;
  readonly onOpenInPanel: () => void;
  readonly pillActions?: ReactNode;
  readonly recording?: boolean;
  /** The clip radius for a given frame; the pill stays inside the curve. */
  readonly cornerRadius?: (frame: PreviewMiniPlayerSize) => number;
  readonly children: (frame: PreviewMiniPlayerFrame) => ReactNode;
}) {
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const controlsPointerTypeRef = useRef<string | null>(null);
  const [pillOpen, setPillOpen] = useState(false);
  const [container, setContainer] = useState({ width: 0, height: 0 });
  const [activeGesture, setActiveGesture] = useState<
    BrowserViewportResizeDirection | "move" | null
  >(null);
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const measure = () => {
      const next = { width: overlay.clientWidth, height: overlay.clientHeight };
      setContainer((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(overlay);
    return () => observer.disconnect();
  }, []);
  const gestureRef = useRef<PointerGesture | null>(null);
  const sourceKey = previewMiniPlayerSourceKey(source);
  const frame =
    miniPlayer && container.width > 0 && container.height > 0
      ? resolvePreviewMiniPlayerFrame({ ...miniPlayer, source: sourceSize, container })
      : null;

  useEffect(() => {
    const cancel = () => {
      gestureRef.current = null;
      setActiveGesture(null);
    };
    window.addEventListener("blur", cancel);
    return () => window.removeEventListener("blur", cancel);
  }, []);

  // Touch has no hover. Tapping the corner dot reveals the same controls,
  // and tapping outside dismisses them.
  useEffect(() => {
    if (!pillOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && controlsRef.current?.contains(event.target)) return;
      setPillOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [pillOpen]);

  const radius = frame ? cornerRadius(frame) : PREVIEW_MINI_PLAYER_CORNER_RADIUS;
  // Inside a wide curve the default 8px inset would land on the clipped-away corner.
  const pillInset = Math.max(8, Math.round(radius * 0.55));

  const close = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
  };

  const beginGesture = (
    event: ReactPointerEvent<HTMLElement>,
    direction: BrowserViewportResizeDirection | null,
  ) => {
    if (event.button !== 0 || !frame || gestureRef.current) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    setActiveGesture(direction ?? "move");
    gestureRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      frame,
      direction,
      moved: false,
    };
    event.preventDefault();
    event.stopPropagation();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    // A lost mouse release must never turn later hover events into a drag.
    if ((event.buttons & 1) === 0) {
      endGesture(event);
      return;
    }
    const delta = { x: event.clientX - gesture.pointerX, y: event.clientY - gesture.pointerY };
    if (!gesture.moved && Math.hypot(delta.x, delta.y) < GESTURE_SLOP_PX) return;
    gesture.moved = true;
    const store = usePreviewMiniPlayerStore.getState();
    if (gesture.direction === null) {
      store.move(
        threadRef,
        sourceKey,
        clampPreviewMiniPlayerPosition(
          { x: gesture.frame.x + delta.x, y: gesture.frame.y + delta.y },
          container,
          gesture.frame,
        ),
      );
      return;
    }
    const next = resizePreviewMiniPlayer({
      start: gesture.frame,
      direction: gesture.direction,
      delta,
      source: sourceSize,
      container,
    });
    store.resize(threadRef, sourceKey, next.width, { x: next.x, y: next.y });
  };

  const endGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (gesture?.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    setActiveGesture(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  // Keep the portal root out of a stacking context: the hosted Electron guest
  // sits between the frame (47) and controls (49) in the document at layer 48.
  return createPortal(
    <div
      ref={overlayRef}
      data-preview-mini-player-overlay
      className="pointer-events-none absolute inset-x-0 bottom-0 top-(--workspace-topbar-height)"
    >
      {activeGesture ? (
        // Cover guests during a gesture so an Electron webview or iframe cannot steal it.
        <div
          className={cn(
            "pointer-events-auto absolute inset-0 z-[49]",
            activeGesture === "move" ? "cursor-grabbing" : RESIZE_CURSOR_CLASSES[activeGesture],
          )}
        />
      ) : null}
      {frame ? (
        <section
          aria-label={label}
          data-preview-mini-player={sourceKey}
          className="pointer-events-none absolute select-none"
          style={{
            left: frame.x,
            top: frame.y,
            width: frame.width,
            height: frame.height,
            borderRadius: radius,
          }}
        >
          <div
            ref={controlsRef}
            data-pill-open={pillOpen || activeGesture === "move" ? "" : undefined}
            className="group pointer-events-auto absolute z-[49] size-3 pointer-coarse:-m-2.5 pointer-coarse:size-8"
            style={{ right: pillInset, top: pillInset }}
          >
            <button
              type="button"
              aria-label="Show floating preview controls"
              className="absolute right-0 top-0 flex size-3 items-start justify-end rounded-full transition-opacity group-hover:pointer-events-none group-hover:opacity-0 group-focus-within:pointer-events-none group-focus-within:opacity-0 group-data-pill-open:pointer-events-none group-data-pill-open:opacity-0 pointer-coarse:right-2.5 pointer-coarse:top-2.5"
              onPointerDown={(event) => {
                controlsPointerTypeRef.current = event.pointerType;
                event.preventDefault();
              }}
              onClick={(event) => {
                if (event.detail === 0 || controlsPointerTypeRef.current === "touch") {
                  setPillOpen((open) => !open);
                }
              }}
            >
              <span
                role={recording ? "status" : undefined}
                aria-label={recording ? "Recording preview" : undefined}
                aria-hidden={!recording}
                className={cn(
                  "block size-2 rounded-full shadow-sm ring-1 ring-background/70",
                  recording
                    ? "bg-destructive motion-safe:animate-status-pulse"
                    : "bg-foreground/25",
                )}
              />
            </button>
            <div className="pointer-events-none absolute right-0 top-0 flex h-8 items-center gap-0.5 rounded-lg border border-border/80 bg-popover/92 p-0.5 opacity-0 shadow-lg/20 backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-data-pill-open:pointer-events-auto group-data-pill-open:opacity-100 pointer-coarse:right-2.5 pointer-coarse:top-2.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Move floating preview"
                      className="flex size-6 shrink-0 touch-none cursor-grab items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring active:cursor-grabbing"
                      onPointerDown={(event) => beginGesture(event, null)}
                      onPointerMove={handlePointerMove}
                      onPointerUp={endGesture}
                      onPointerCancel={endGesture}
                      onLostPointerCapture={endGesture}
                      onKeyDown={(event) => {
                        if (!frame) return;
                        const delta = MOVE_DELTAS[event.key];
                        if (!delta) return;
                        event.preventDefault();
                        const step = event.shiftKey ? 40 : 10;
                        usePreviewMiniPlayerStore
                          .getState()
                          .move(
                            threadRef,
                            sourceKey,
                            clampPreviewMiniPlayerPosition(
                              { x: frame.x + delta.x * step, y: frame.y + delta.y * step },
                              container,
                              frame,
                            ),
                          );
                      }}
                    />
                  }
                >
                  <GripIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="top">Hold and drag to move preview</TooltipPopup>
              </Tooltip>
              {recording ? (
                <span
                  role="status"
                  aria-label="Recording preview"
                  className="flex size-6 shrink-0 items-center justify-center"
                >
                  <span className="size-2 rounded-full bg-destructive motion-safe:animate-status-pulse" />
                </span>
              ) : null}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Open preview in right panel"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={onOpenInPanel}
                    />
                  }
                >
                  <PanelRightIcon />
                </TooltipTrigger>
                <TooltipPopup side="top">Open in right panel</TooltipPopup>
              </Tooltip>
              {pillActions}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Close floating preview"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={close}
                    />
                  }
                >
                  <XIcon />
                </TooltipTrigger>
                <TooltipPopup side="top">Close floating preview</TooltipPopup>
              </Tooltip>
            </div>
          </div>

          <div className="absolute inset-0 z-[47] rounded-[inherit] bg-muted shadow-2xl/35" />
          {children(frame)}
          <div className="pointer-events-none absolute inset-0 z-[49] rounded-[inherit] ring-1 ring-inset ring-border/80" />
          {RESIZE_HANDLES.map(({ direction, className }) => (
            <div
              key={direction}
              role="presentation"
              data-preview-mini-player-resize={direction}
              className={cn("pointer-events-auto absolute z-[49] touch-none", className)}
              onPointerDown={(event) => beginGesture(event, direction)}
              onPointerMove={handlePointerMove}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
              onLostPointerCapture={endGesture}
            />
          ))}
        </section>
      ) : null}
    </div>,
    document.body,
  );
}
