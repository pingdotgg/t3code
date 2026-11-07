import { XIcon } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { previewBridge } from "~/components/preview/previewBridge";
import { cn } from "~/lib/utils";

import type { BrowserSurfaceRect } from "./browserSurfaceStore";
import { withDesktopTab } from "./desktopTabLifetime";
import { resolveHostedBrowserWebviewWrapperStyle } from "./hostedBrowserWebviewStyle";
import { type DockedDevTools, usePreviewDevToolsStore } from "./previewDevTools";

const HEADER_HEIGHT = 28;
const RESIZE_HANDLE_SIZE = 4;
// Native views paint above the page, so these popups would open underneath docked DevTools.
const HOST_OVERLAY_SELECTOR = [
  "menu",
  "select",
  "popover",
  "combobox",
  "autocomplete",
  "preview-card",
  "dialog",
  "alert-dialog",
  "command-dialog",
  "sheet",
]
  .flatMap((slot) => [`[data-slot="${slot}-popup"]`, `[data-slot="${slot}-backdrop"]`])
  .join(",");

const intersects = (element: Element, rect: BrowserSurfaceRect) => {
  const box = element.getBoundingClientRect();
  return (
    box.width > 0 &&
    box.height > 0 &&
    box.left < rect.x + rect.width &&
    box.right > rect.x &&
    box.top < rect.y + rect.height &&
    box.bottom > rect.y
  );
};

function useObscuredByHostOverlay(rect: BrowserSurfaceRect | null): boolean {
  const [obscured, setObscured] = useState(false);
  const left = rect?.x;
  const top = rect?.y;
  const width = rect?.width;
  const height = rect?.height;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- watches the app's popups so docked DevTools hide while one overlaps them
  useEffect(() => {
    if (left === undefined || top === undefined || width === undefined || height === undefined) {
      return;
    }
    const area = { x: left, y: top, width, height };
    let frame: number | null = null;
    const check = () => {
      frame = null;
      setObscured(
        Array.from(document.querySelectorAll(HOST_OVERLAY_SELECTOR)).some((element) =>
          intersects(element, area),
        ),
      );
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(check);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-open", "data-closed", "style"],
    });
    schedule();
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [left, top, width, height]);
  return rect !== null && obscured;
}

/** Reserves the panel area that the desktop's native DevTools view is placed over. */
export function DockedDevToolsArea(props: {
  readonly runtimeTabId: string;
  readonly dock: DockedDevTools;
  readonly active: boolean;
  readonly panelRect: BrowserSurfaceRect | null;
  readonly rect: BrowserSurfaceRect | null;
  readonly zIndex: number;
}) {
  const { runtimeTabId, dock, active, panelRect, rect, zIndex } = props;
  const [dragging, setDragging] = useState(false);
  const right = dock.side === "right";
  const contentRect =
    active && rect
      ? {
          x: rect.x + (right ? RESIZE_HANDLE_SIZE : 0),
          y: rect.y + HEADER_HEIGHT + (right ? 0 : RESIZE_HANDLE_SIZE),
          width: Math.max(0, rect.width - (right ? RESIZE_HANDLE_SIZE : 0)),
          height: Math.max(0, rect.height - HEADER_HEIGHT - (right ? 0 : RESIZE_HANDLE_SIZE)),
        }
      : null;
  const obscured = useObscuredByHostOverlay(contentRect);
  // The native view would swallow the pointer while resizing over it.
  const shownRect = obscured || dragging ? null : contentRect;
  const shownX = shownRect?.x;
  const shownY = shownRect?.y;
  const shownWidth = shownRect?.width;
  const shownHeight = shownRect?.height;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- places the desktop's native DevTools view over this area
  useEffect(() => {
    const bridge = previewBridge;
    if (!bridge) return;
    const bounds =
      shownX === undefined ||
      shownY === undefined ||
      shownWidth === undefined ||
      shownHeight === undefined
        ? null
        : { x: shownX, y: shownY, width: shownWidth, height: shownHeight };
    withDesktopTab(runtimeTabId, () => bridge.setDevToolsBounds(runtimeTabId, bounds));
  }, [runtimeTabId, shownX, shownY, shownWidth, shownHeight]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hides the native DevTools view when this area unmounts
  useEffect(() => {
    const bridge = previewBridge;
    return () => {
      if (bridge) withDesktopTab(runtimeTabId, () => bridge.setDevToolsBounds(runtimeTabId, null));
    };
  }, [runtimeTabId]);

  const close = () => {
    const bridge = previewBridge;
    if (bridge) withDesktopTab(runtimeTabId, () => bridge.closeDevTools(runtimeTabId));
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!panelRect || event.button !== 0) return;
    event.preventDefault();
    setDragging(true);
  };
  const handleResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!panelRect) return;
    const fraction = right
      ? (panelRect.x + panelRect.width - event.clientX) / panelRect.width
      : (panelRect.y + panelRect.height - event.clientY) / panelRect.height;
    usePreviewDevToolsStore.getState().resize(runtimeTabId, fraction);
  };

  const style = resolveHostedBrowserWebviewWrapperStyle({
    active: active && rect !== null,
    renderingActive: false,
    zIndex,
    rect,
    hiddenSize: { width: rect?.width ?? 0, height: rect?.height ?? 0 },
  });

  return (
    <div
      className={cn("fixed flex bg-background", right ? "flex-row" : "flex-col")}
      style={style}
      data-preview-devtools={runtimeTabId}
    >
      <div
        role="separator"
        aria-orientation={right ? "vertical" : "horizontal"}
        aria-label="Resize DevTools"
        className={cn(
          "shrink-0 bg-border transition-colors hover:bg-primary/60",
          dragging && "bg-primary/60",
          right ? "cursor-col-resize" : "cursor-row-resize",
        )}
        style={right ? { width: RESIZE_HANDLE_SIZE } : { height: RESIZE_HANDLE_SIZE }}
        onPointerDown={handleResizePointerDown}
      />
      {dragging ? (
        // The page's webview would take the pointer as it crosses it.
        <div
          className={cn("fixed inset-0 z-50", right ? "cursor-col-resize" : "cursor-row-resize")}
          onPointerMove={handleResizePointerMove}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
        />
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/60 pr-1 pl-3 text-xs text-muted-foreground"
          style={{ height: HEADER_HEIGHT }}
        >
          <span className="min-w-0 flex-1 truncate font-medium">DevTools</span>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Close DevTools"
            title="Close DevTools"
            onClick={close}
          >
            <XIcon />
          </Button>
        </div>
        <div className="min-h-0 flex-1" />
      </div>
    </div>
  );
}
