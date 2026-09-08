"use client";

import { FILL_PREVIEW_VIEWPORT, type ScopedThreadRef } from "@t3tools/contracts";
import { PanelRightIcon, PictureInPicture2, XIcon } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useLayoutEffect, useRef, useState } from "react";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import type { BrowserViewportResizeDirection } from "~/browser/browserViewportLayout";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useThreadPreviewState } from "~/previewStateStore";
import {
  type PreviewMiniPlayerSize,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { previewBridge } from "./previewBridge";
import {
  clampPreviewMiniPlayerPosition,
  PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX,
  type PreviewMiniPlayerFrame,
  resizePreviewMiniPlayer,
  resolvePreviewMiniPlayerFrame,
  resolvePreviewMiniPlayerSourceSize,
} from "./previewMiniPlayerLayout";

interface PointerGesture {
  readonly pointerId: number;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly frame: PreviewMiniPlayerFrame;
  readonly direction: BrowserViewportResizeDirection | null;
}

interface Props {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly bottomInset: number;
}

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

export function ThreadPreviewMiniPlayer({ threadRef, tabId, bottomInset }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<PointerGesture | null>(null);
  const [container, setContainer] = useState<PreviewMiniPlayerSize | null>(null);
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  const previewState = useThreadPreviewState(threadRef);
  const snapshot = previewState.sessions[tabId] ?? null;
  const runtimeTabId = previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId);
  const desktopOverlay = previewState.desktopByTabId[tabId] ?? null;
  const fittedSourceContent = useBrowserSurfaceStore(
    (state) => state.byTabId[runtimeTabId]?.fittedSourceContent ?? null,
  );
  const source = resolvePreviewMiniPlayerSourceSize(
    snapshot?.viewport ?? FILL_PREVIEW_VIEWPORT,
    fittedSourceContent,
    desktopOverlay?.zoomFactor ?? 1,
  );
  const frame =
    container && miniPlayer?.tabId === tabId
      ? resolvePreviewMiniPlayerFrame({
          width: miniPlayer.width,
          position: miniPlayer.position,
          source,
          container,
          bottomInset,
        })
      : null;

  const close = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
  };

  const openInPanel = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
    useRightPanelStore.getState().openBrowser(threadRef, tabId);
  };

  const toggleNativePictureInPicture = () => {
    if (!previewBridge) return;
    const operation = desktopOverlay?.pictureInPicture
      ? previewBridge.pictureInPicture.close
      : previewBridge.pictureInPicture.open;
    void operation(runtimeTabId).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to update popped-out preview",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  };

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      setContainer((current) =>
        current?.width === element.clientWidth && current.height === element.clientHeight
          ? current
          : { width: element.clientWidth, height: element.clientHeight },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const beginGesture = (
    event: ReactPointerEvent<HTMLElement>,
    direction: BrowserViewportResizeDirection | null,
  ) => {
    if (event.button !== 0 || !frame) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      frame,
      direction,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !container) return;
    const delta = { x: event.clientX - gesture.pointerX, y: event.clientY - gesture.pointerY };
    const store = usePreviewMiniPlayerStore.getState();
    if (gesture.direction === null) {
      store.move(
        threadRef,
        tabId,
        clampPreviewMiniPlayerPosition(
          { x: gesture.frame.x + delta.x, y: gesture.frame.y + delta.y },
          container,
          gesture.frame,
          bottomInset,
        ),
      );
      return;
    }
    const next = resizePreviewMiniPlayer({
      start: gesture.frame,
      direction: gesture.direction,
      delta,
      source,
      container,
      bottomInset,
    });
    store.resize(threadRef, tabId, next.width);
    store.move(threadRef, tabId, { x: next.x, y: next.y });
  };

  const endGesture = (event: ReactPointerEvent<HTMLElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (!snapshot || miniPlayer?.tabId !== tabId) return null;

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0">
      {frame ? (
        <section
          aria-label="Floating browser preview"
          data-preview-mini-player={tabId}
          className="pointer-events-none absolute select-none"
          style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
        >
          <div className="group pointer-events-auto absolute right-2 top-2 z-[49] size-3">
            <div
              aria-hidden="true"
              className="absolute right-0 top-0 size-2 rounded-full bg-foreground/25 shadow-sm ring-1 ring-background/70 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
            />
            <div
              className="pointer-events-none absolute right-0 top-0 flex h-8 cursor-grab items-center gap-0.5 rounded-lg border border-border/80 bg-popover/92 p-0.5 opacity-0 shadow-lg/20 backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 active:cursor-grabbing"
              onPointerDown={(event) => beginGesture(event, null)}
              onPointerMove={handlePointerMove}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Open preview in right panel"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={openInPanel}
                    />
                  }
                >
                  <PanelRightIcon />
                </TooltipTrigger>
                <TooltipPopup side="top">Open in right panel</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant={desktopOverlay?.pictureInPicture ? "secondary" : "ghost"}
                      size="icon-xs"
                      aria-label={
                        desktopOverlay?.pictureInPicture
                          ? "Close popped-out preview"
                          : "Pop preview into separate window"
                      }
                      disabled={!desktopOverlay?.hasWebContents}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={toggleNativePictureInPicture}
                    />
                  }
                >
                  <PictureInPicture2 />
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {desktopOverlay?.pictureInPicture
                    ? "Close separate window"
                    : "Pop into separate window"}
                </TooltipPopup>
              </Tooltip>
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

          <div className="absolute inset-0 z-[47] rounded-xl bg-muted shadow-2xl/35" />
          <BrowserSurfaceSlot
            tabId={runtimeTabId}
            visible={Boolean(desktopOverlay?.hasWebContents)}
            cornerRadius={12}
            zIndex={PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX}
            fitSourceContent
            layoutVersion={`${frame.x}:${frame.y}`}
            className="absolute inset-0"
          />
          <div className="pointer-events-none absolute inset-0 z-[49] rounded-xl ring-1 ring-inset ring-border/80" />
          {!desktopOverlay?.hasWebContents ? (
            <div className="pointer-events-none absolute inset-0 z-[49] flex items-center justify-center rounded-xl bg-muted text-xs text-muted-foreground">
              Reconnecting preview…
            </div>
          ) : null}
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
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}
