"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Grip, PanelRight, PictureInPicture2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useThreadPreviewState } from "~/previewStateStore";
import {
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
  type PreviewMiniPlayerPosition,
  type PreviewMiniPlayerSize,
} from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { previewBridge } from "./previewBridge";
import { subscribePreviewAction } from "./previewActionBus";
import {
  clampPreviewMiniPlayerPosition,
  clampPreviewMiniPlayerSize,
  PREVIEW_MINI_PLAYER_DEFAULT_SIZE,
} from "./previewMiniPlayerLayout";
import { handlePreviewZoomAction } from "./previewZoomAction";

interface PointerState {
  readonly pointerId: number;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly position: PreviewMiniPlayerPosition;
  readonly size: PreviewMiniPlayerSize;
}

export function ThreadPreviewMiniPlayer(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId?: string | null;
  readonly bottomInset?: number | undefined;
}) {
  const { threadRef } = props;
  const bottomInset = props.bottomInset ?? 0;
  const rootRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<PointerState | null>(null);
  const resizeRef = useRef<PointerState | null>(null);
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  const previewState = useThreadPreviewState(threadRef);
  const tabId = props.tabId ?? miniPlayer?.tabId ?? previewState.activeTabId;
  const snapshot = tabId ? (previewState.sessions[tabId] ?? null) : null;
  const overlay = tabId ? (previewState.desktopByTabId[tabId] ?? null) : null;
  const runtimeTabId = tabId
    ? previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId)
    : null;
  const size = miniPlayer?.size ?? PREVIEW_MINI_PLAYER_DEFAULT_SIZE;
  const position = miniPlayer?.tabId === tabId ? (miniPlayer.position ?? null) : null;
  const isOpen =
    tabId != null && runtimeTabId != null && miniPlayer?.tabId === tabId && snapshot != null;
  const preserveSourceViewport = snapshot?.viewport != null && snapshot.viewport._tag !== "fill";

  useEffect(() => {
    const bridge = previewBridge;
    if (!isOpen || !bridge || !runtimeTabId) return;
    return subscribePreviewAction((action) => {
      handlePreviewZoomAction(action, bridge, runtimeTabId);
    });
  }, [isOpen, runtimeTabId]);

  useLayoutEffect(() => {
    if (!isOpen || !tabId) return;
    const clampAndMove = () => {
      const root = rootRef.current;
      const parent = root?.offsetParent;
      if (!root || !(parent instanceof HTMLElement)) return;
      const container = { width: parent.clientWidth, height: parent.clientHeight };
      const nextSize = clampPreviewMiniPlayerSize(
        { width: root.offsetWidth, height: root.offsetHeight },
        container,
        bottomInset,
      );
      usePreviewMiniPlayerStore.getState().resize(threadRef, tabId, nextSize);
      usePreviewMiniPlayerStore
        .getState()
        .move(
          threadRef,
          tabId,
          clampPreviewMiniPlayerPosition(
            position ?? { x: root.offsetLeft, y: root.offsetTop },
            container,
            nextSize,
            bottomInset,
          ),
        );
    };
    clampAndMove();
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!root || !(parent instanceof HTMLElement) || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(clampAndMove);
    observer.observe(root);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [bottomInset, isOpen, position, tabId, threadRef]);

  const withContainer = (
    event: ReactPointerEvent<HTMLElement>,
    callback: (container: PreviewMiniPlayerSize, root: HTMLElement) => void,
  ) => {
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!root || !(parent instanceof HTMLElement)) return;
    callback({ width: parent.clientWidth, height: parent.clientHeight }, root);
    event.preventDefault();
  };
  const endPointer = (event: ReactPointerEvent<HTMLElement>, reference: typeof dragRef) => {
    if (reference.current?.pointerId !== event.pointerId) return;
    reference.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) =>
    withContainer(event, (_container, root) => {
      const parentRect = root.offsetParent!.getBoundingClientRect();
      const rect = root.getBoundingClientRect();
      dragRef.current = {
        pointerId: event.pointerId,
        pointerX: event.clientX,
        pointerY: event.clientY,
        position: { x: rect.left - parentRect.left, y: rect.top - parentRect.top },
        size: { width: root.offsetWidth, height: root.offsetHeight },
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    });
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !tabId) return;
    withContainer(event, (container) => {
      usePreviewMiniPlayerStore.getState().move(
        threadRef,
        tabId,
        clampPreviewMiniPlayerPosition(
          {
            x: drag.position.x + event.clientX - drag.pointerX,
            y: drag.position.y + event.clientY - drag.pointerY,
          },
          container,
          drag.size,
          bottomInset,
        ),
      );
    });
  };
  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) =>
    withContainer(event, (_container, root) => {
      resizeRef.current = {
        pointerId: event.pointerId,
        pointerX: event.clientX,
        pointerY: event.clientY,
        position: position ?? { x: root.offsetLeft, y: root.offsetTop },
        size: { width: root.offsetWidth, height: root.offsetHeight },
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.stopPropagation();
    });
  const moveResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId || !tabId) return;
    withContainer(event, (container) => {
      const next = clampPreviewMiniPlayerSize(
        {
          width: resize.size.width + event.clientX - resize.pointerX,
          height: resize.size.height + event.clientY - resize.pointerY,
        },
        container,
        bottomInset,
      );
      usePreviewMiniPlayerStore.getState().resize(threadRef, tabId, next);
      usePreviewMiniPlayerStore
        .getState()
        .move(
          threadRef,
          tabId,
          clampPreviewMiniPlayerPosition(resize.position, container, next, bottomInset),
        );
    });
  };
  const toggleNativePictureInPicture = () => {
    if (!previewBridge || !runtimeTabId) return;
    const action = overlay?.pictureInPicture
      ? previewBridge.pictureInPicture.close
      : previewBridge.pictureInPicture.open;
    void action(runtimeTabId).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to update popped-out preview",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  };

  if (!isOpen || !tabId || !runtimeTabId) return null;

  return (
    <section
      ref={rootRef}
      aria-label="Floating browser preview"
      data-preview-mini-player={tabId}
      className="pointer-events-none absolute select-none"
      style={
        position
          ? { left: position.x, top: position.y, width: size.width, height: size.height }
          : { right: 16, top: 16, width: size.width, height: size.height }
      }
    >
      <div className="pointer-events-auto absolute right-2 top-2 z-[34] flex items-center gap-1">
        <span
          aria-label={overlay === null ? "Preview reconnecting" : "Preview active"}
          className={`size-2 rounded-full border border-background/70 shadow-sm ${
            overlay === null ? "animate-status-pulse bg-amber-400" : "bg-emerald-400"
          }`}
        />
        <div
          className="group flex cursor-grab items-center gap-0.5 rounded-md border border-border/70 bg-popover/75 p-0.5 shadow-md backdrop-blur-md transition-[padding,background-color] hover:bg-popover/90 focus-within:bg-popover/90 active:cursor-grabbing"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={(event) => endPointer(event, dragRef)}
          onPointerCancel={(event) => endPointer(event, dragRef)}
        >
          <Grip
            aria-hidden
            className="size-3 text-muted-foreground/70 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
          />
          <div className="flex w-0 overflow-hidden opacity-0 transition-[width,opacity] group-hover:w-[84px] group-hover:opacity-100 group-focus-within:w-[84px] group-focus-within:opacity-100 pointer-coarse:w-[84px] pointer-coarse:opacity-100">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Open preview in panel"
              title="Open in panel"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                usePreviewMiniPlayerStore.getState().close(threadRef);
                useRightPanelStore.getState().openBrowser(threadRef, tabId);
              }}
            >
              <PanelRight />
            </Button>
            <Button
              variant={overlay?.pictureInPicture ? "secondary" : "ghost"}
              size="icon-xs"
              aria-label={
                overlay?.pictureInPicture
                  ? "Close popped-out preview"
                  : "Pop preview into separate window"
              }
              title={
                overlay?.pictureInPicture ? "Close separate window" : "Pop into separate window"
              }
              disabled={overlay === null}
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
              onClick={() => usePreviewMiniPlayerStore.getState().close(threadRef)}
            >
              <X />
            </Button>
          </div>
        </div>
      </div>
      <div className="relative h-full min-h-0">
        <div className="absolute inset-0 z-[29] rounded-xl bg-muted shadow-xl" />
        <BrowserSurfaceSlot
          tabId={runtimeTabId}
          visible={overlay !== null}
          cornerRadius={12}
          fitSourceContent={preserveSourceViewport}
          layoutVersion={
            position
              ? `${position.x}:${position.y}:${size.width}:${size.height}`
              : `initial:${bottomInset}`
          }
          className="absolute inset-0"
        />
        <div className="pointer-events-none absolute inset-0 z-[31] rounded-xl ring-1 ring-inset ring-border" />
        {overlay === null ? (
          <div className="pointer-events-none absolute inset-0 z-[32] grid place-items-center rounded-xl bg-muted text-xs text-muted-foreground">
            Reconnecting preview...
          </div>
        ) : null}
        <button
          type="button"
          aria-label="Resize floating preview"
          className="pointer-events-auto absolute bottom-0 right-0 z-[33] grid size-5 cursor-nwse-resize place-items-end rounded-br-xl p-0.5 text-muted-foreground/80"
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={(event) => endPointer(event, resizeRef)}
          onPointerCancel={(event) => endPointer(event, resizeRef)}
        >
          <svg aria-hidden viewBox="0 0 8 8" className="size-2.5 fill-current">
            <path d="M8 2v2L4 8H2L8 2Zm0 4v2H6l2-2Z" />
          </svg>
        </button>
      </div>
    </section>
  );
}
