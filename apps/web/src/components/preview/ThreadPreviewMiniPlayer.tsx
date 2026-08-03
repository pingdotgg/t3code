"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { PanelRight, PictureInPicture2, X } from "lucide-react";
import { useRef } from "react";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { Button } from "~/components/ui/button";
import { useThreadPreviewState } from "~/previewStateStore";
import {
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
  type PreviewMiniPlayerPosition,
  type PreviewMiniPlayerSize,
} from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { previewBridge } from "./previewBridge";
import {
  clampPreviewMiniPlayerPosition,
  clampPreviewMiniPlayerSize,
  PREVIEW_MINI_PLAYER_DEFAULT_SIZE,
} from "./previewMiniPlayerLayout";

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
}) {
  const { threadRef } = props;
  const rootRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<PointerState | null>(null);
  const resizeRef = useRef<PointerState | null>(null);
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  const previewState = useThreadPreviewState(threadRef);
  const tabId = props.tabId ?? previewState.activeTabId;
  if (!tabId) return null;
  const overlay = previewState.desktopByTabId[tabId] ?? null;
  const runtimeTabId = previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId);
  if (miniPlayer?.tabId !== tabId || !previewState.sessions[tabId]) return null;

  const size = miniPlayer.size ?? PREVIEW_MINI_PLAYER_DEFAULT_SIZE;
  const position = miniPlayer.position;
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
    if (!drag || drag.pointerId !== event.pointerId) return;
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
    if (!resize || resize.pointerId !== event.pointerId) return;
    withContainer(event, (container) => {
      const next = clampPreviewMiniPlayerSize(
        {
          width: resize.size.width + event.clientX - resize.pointerX,
          height: resize.size.height + event.clientY - resize.pointerY,
        },
        container,
      );
      usePreviewMiniPlayerStore.getState().resize(threadRef, tabId, next);
      usePreviewMiniPlayerStore
        .getState()
        .move(threadRef, tabId, clampPreviewMiniPlayerPosition(resize.position, container, next));
    });
  };
  const toggleNativePictureInPicture = () => {
    if (!previewBridge) return;
    const action = overlay?.pictureInPicture
      ? previewBridge.pictureInPicture.close
      : previewBridge.pictureInPicture.open;
    void action(runtimeTabId).catch(() => undefined);
  };

  return (
    <section
      ref={rootRef}
      aria-label="Floating browser preview"
      className="pointer-events-none absolute z-50 select-none"
      style={
        position
          ? { left: position.x, top: position.y, width: size.width, height: size.height }
          : { right: 16, top: 16, width: size.width, height: size.height }
      }
    >
      <div
        className="pointer-events-auto absolute right-2 top-2 z-10 flex cursor-grab gap-0.5 rounded-lg border bg-popover/95 p-0.5 shadow-lg active:cursor-grabbing"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={(event) => endPointer(event, dragRef)}
        onPointerCancel={(event) => endPointer(event, dragRef)}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Open preview in panel"
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
          aria-label="Pop preview into separate window"
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
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => usePreviewMiniPlayerStore.getState().close(threadRef)}
        >
          <X />
        </Button>
      </div>
      <div className="pointer-events-auto relative h-full overflow-hidden rounded-xl bg-muted shadow-2xl ring-1 ring-border">
        <BrowserSurfaceSlot
          tabId={runtimeTabId}
          visible={overlay !== null}
          layoutVersion={
            position ? `${position.x}:${position.y}:${size.width}:${size.height}` : "initial"
          }
          className="absolute inset-0"
        />
        {overlay === null ? (
          <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            Reconnecting preview...
          </div>
        ) : null}
        <button
          type="button"
          aria-label="Resize floating preview"
          className="absolute bottom-0 right-0 size-5 cursor-nwse-resize"
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={(event) => endPointer(event, resizeRef)}
          onPointerCancel={(event) => endPointer(event, resizeRef)}
        />
      </div>
    </section>
  );
}
