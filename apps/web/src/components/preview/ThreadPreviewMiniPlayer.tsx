"use client";

import type { ScopedThreadRef } from "@t3tools/contracts";
import { PanelRightIcon, PictureInPicture2, XIcon } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useLayoutEffect, useRef } from "react";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useThreadPreviewState } from "~/previewStateStore";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { previewBridge } from "./previewBridge";
import {
  clampPreviewMiniPlayerPosition,
  clampPreviewMiniPlayerSize,
  defaultPreviewMiniPlayerPosition,
  PREVIEW_MINI_PLAYER_DEFAULT_SIZE,
} from "./previewMiniPlayerLayout";

/**
 * Where a freshly opened player should land: under the inline thread-details
 * card when that panel is open (it owns the top-right corner), otherwise the
 * top-right CSS placement the element already has.
 */
function initialPreviewMiniPlayerPosition(root: HTMLElement, parent: HTMLElement) {
  const fallback = { x: root.offsetLeft, y: root.offsetTop };
  const card = root
    .closest('[data-thread-details-inline-reserved="true"]')
    ?.querySelector('[data-thread-details-panel="inline"] [data-thread-details-card]');
  if (!(card instanceof HTMLElement)) return fallback;
  const cardRect = card.getBoundingClientRect();
  return defaultPreviewMiniPlayerPosition({
    fallback,
    parentRect: parent.getBoundingClientRect(),
    playerWidth: root.offsetWidth,
    detailsCardRect: { right: cardRect.right, bottom: cardRect.bottom },
  });
}

interface DragState {
  readonly pointerId: number;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly playerX: number;
  readonly playerY: number;
}

interface ResizeState {
  readonly pointerId: number;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly width: number;
  readonly height: number;
}

interface Props {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly bottomInset: number;
}

export function ThreadPreviewMiniPlayer({ threadRef, tabId, bottomInset }: Props) {
  const rootRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  const previewState = useThreadPreviewState(threadRef);
  const snapshot = previewState.sessions[tabId] ?? null;
  const runtimeTabId = previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId);
  const desktopOverlay = previewState.desktopByTabId[tabId] ?? null;
  const position = miniPlayer?.tabId === tabId ? miniPlayer.position : null;
  const size =
    miniPlayer?.tabId === tabId && miniPlayer.size
      ? miniPlayer.size
      : PREVIEW_MINI_PLAYER_DEFAULT_SIZE;
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
    const clampAndMove = () => {
      const root = rootRef.current;
      const parent = root?.offsetParent;
      if (!root || !(parent instanceof HTMLElement)) return;
      const nextSize = clampPreviewMiniPlayerSize(
        { width: root.offsetWidth, height: root.offsetHeight },
        { width: parent.clientWidth, height: parent.clientHeight },
        bottomInset,
      );
      usePreviewMiniPlayerStore.getState().resize(threadRef, tabId, nextSize);
      const next = clampPreviewMiniPlayerPosition(
        position ?? initialPreviewMiniPlayerPosition(root, parent),
        { width: parent.clientWidth, height: parent.clientHeight },
        nextSize,
        bottomInset,
      );
      usePreviewMiniPlayerStore.getState().move(threadRef, tabId, next);
    };
    clampAndMove();
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!root || !(parent instanceof HTMLElement) || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(clampAndMove);
    observer.observe(root);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [bottomInset, position, tabId, threadRef]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!root || !(parent instanceof HTMLElement)) return;
    const rootRect = root.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      playerX: rootRect.left - parentRect.left,
      playerY: rootRect.top - parentRect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!drag || drag.pointerId !== event.pointerId || !root || !(parent instanceof HTMLElement)) {
      return;
    }
    const next = clampPreviewMiniPlayerPosition(
      {
        x: drag.playerX + event.clientX - drag.pointerX,
        y: drag.playerY + event.clientY - drag.pointerY,
      },
      { width: parent.clientWidth, height: parent.clientHeight },
      { width: root.offsetWidth, height: root.offsetHeight },
      bottomInset,
    );
    usePreviewMiniPlayerStore.getState().move(threadRef, tabId, next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const root = rootRef.current;
    if (!root) return;
    resizeRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      width: root.offsetWidth,
      height: root.offsetHeight,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (
      !resize ||
      resize.pointerId !== event.pointerId ||
      !root ||
      !(parent instanceof HTMLElement)
    ) {
      return;
    }
    const nextSize = clampPreviewMiniPlayerSize(
      {
        width: resize.width + event.clientX - resize.pointerX,
        height: resize.height + event.clientY - resize.pointerY,
      },
      { width: parent.clientWidth, height: parent.clientHeight },
      bottomInset,
    );
    usePreviewMiniPlayerStore.getState().resize(threadRef, tabId, nextSize);
    const nextPosition = clampPreviewMiniPlayerPosition(
      position ?? { x: root.offsetLeft, y: root.offsetTop },
      { width: parent.clientWidth, height: parent.clientHeight },
      nextSize,
      bottomInset,
    );
    usePreviewMiniPlayerStore.getState().move(threadRef, tabId, nextPosition);
  };

  const endResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (!snapshot || miniPlayer?.tabId !== tabId) return null;

  return (
    <section
      ref={rootRef}
      aria-label="Floating browser preview"
      data-preview-mini-player={tabId}
      className="pointer-events-none absolute select-none"
      style={
        position
          ? { left: position.x, top: position.y, width: size.width, height: size.height }
          : {
              right: 16,
              top: 16,
              width: size.width,
              height: size.height,
            }
      }
    >
      <div className="group pointer-events-auto absolute right-2 top-2 z-[34] size-3">
        <div
          aria-hidden="true"
          className="absolute right-0 top-0 size-2 rounded-full bg-foreground/25 shadow-sm ring-1 ring-background/70 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
        />
        <div
          className="pointer-events-none absolute right-0 top-0 flex h-8 cursor-grab items-center gap-0.5 rounded-lg border border-border/80 bg-popover/92 p-0.5 opacity-0 shadow-lg/20 backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 active:cursor-grabbing"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Open preview in right panel"
            title="Open in right panel"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={openInPanel}
          >
            <PanelRightIcon />
          </Button>
          <Button
            variant={desktopOverlay?.pictureInPicture ? "secondary" : "ghost"}
            size="icon-xs"
            aria-label={
              desktopOverlay?.pictureInPicture
                ? "Close popped-out preview"
                : "Pop preview into separate window"
            }
            title={
              desktopOverlay?.pictureInPicture
                ? "Close separate window"
                : "Pop into separate window"
            }
            disabled={!desktopOverlay?.hasWebContents}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={toggleNativePictureInPicture}
          >
            <PictureInPicture2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close floating preview"
            title="Close floating preview"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={close}
          >
            <XIcon />
          </Button>
        </div>
      </div>

      <div className="relative h-full min-h-0">
        <div className="absolute inset-0 z-[29] rounded-xl bg-muted shadow-2xl/35" />
        <BrowserSurfaceSlot
          tabId={runtimeTabId}
          visible={Boolean(desktopOverlay?.hasWebContents)}
          cornerRadius={12}
          fitSourceContent
          layoutVersion={position ? `${position.x}:${position.y}` : `initial:${bottomInset}`}
          className="absolute inset-0"
        />
        <div className="pointer-events-none absolute inset-0 z-[31] rounded-xl ring-1 ring-inset ring-border/80" />
        {!desktopOverlay?.hasWebContents ? (
          <div className="pointer-events-none absolute inset-0 z-[32] flex items-center justify-center rounded-xl bg-muted text-xs text-muted-foreground">
            Reconnecting preview…
          </div>
        ) : null}
        <button
          type="button"
          aria-label="Resize floating preview"
          title="Resize floating preview"
          className="pointer-events-auto absolute bottom-0 right-0 z-[33] size-5 cursor-nwse-resize rounded-br-xl after:absolute after:bottom-1 after:right-1 after:size-2 after:border-b after:border-r after:border-foreground/45"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
      </div>
    </section>
  );
}
