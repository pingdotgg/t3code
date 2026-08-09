import { Fragment, type CSSProperties, type ReactNode, useEffect, useState } from "react";

import { isElectron } from "~/env";
import { useResizableWidth } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

import { RightPanelResizeHandle } from "./RightPanelResizeHandle";

export type PreviewPanelMode = "inline" | "sheet" | "sidebar" | "embedded";

const PREVIEW_PANEL_WIDTH_STORAGE_KEY = "t3code:preview-panel-width";
const PREVIEW_PANEL_MIN_WIDTH = 360;
/** Fraction of the viewport allowed, preserving the remaining space for chat. */
const PREVIEW_PANEL_MAX_WIDTH_FRACTION = 0.7;
const PREVIEW_PANEL_DEFAULT_WIDTH = 540;

export function getPreviewPanelMaxWidth(viewportWidth: number): number {
  return Math.floor(viewportWidth * PREVIEW_PANEL_MAX_WIDTH_FRACTION);
}

/**
 * Shell for the preview panel. In inline mode the panel is user-resizable
 * via a drag handle on the left edge; width persists per browser. In
 * sheet/sidebar modes the parent owns the size.
 */
export function PreviewPanelShell(props: {
  mode: PreviewPanelMode;
  maximized?: boolean;
  open?: boolean;
  onExitComplete?: () => void;
  children: ReactNode;
}) {
  const useDragRegion = isElectron && props.mode !== "sheet" && props.mode !== "embedded";
  const isInline = props.mode === "inline";
  const maximized = props.maximized === true;
  const open = props.open ?? true;
  const maxWidth = useViewportClampedMaxWidth();
  const { width, isResizing, handlers } = useResizableWidth({
    storageKey: PREVIEW_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: PREVIEW_PANEL_DEFAULT_WIDTH,
    minWidth: PREVIEW_PANEL_MIN_WIDTH,
    maxWidth,
    edge: "left",
  });

  const panelContents = (
    <>
      {isInline && !maximized ? (
        <RightPanelResizeHandle key="resize-handle" handlers={handlers} />
      ) : null}
      {useDragRegion ? (
        <div key="drag-region" className="electron-drag-region h-0 w-full" aria-hidden />
      ) : null}
      <Fragment key="panel-contents">{props.children}</Fragment>
    </>
  );

  if (isInline) {
    return (
      <div
        className={cn(
          "right-panel-inline-frame relative h-full min-h-0 min-w-0 self-stretch",
          maximized
            ? open
              ? "flex-1"
              : "right-panel-inline-maximized-exit absolute inset-0 z-10"
            : "right-panel-inline-gap shrink-0",
        )}
        style={maximized ? undefined : ({ "--right-panel-width": `${width}px` } as CSSProperties)}
        data-preview-panel-mode={props.mode}
        data-preview-panel-maximized={maximized ? "true" : "false"}
        data-right-panel-open={open ? "true" : "false"}
        data-right-panel-resizing={!maximized && isResizing ? "true" : undefined}
        aria-hidden={open ? undefined : true}
        inert={open ? undefined : true}
        onTransitionEnd={(event) => {
          if (open || event.target !== event.currentTarget || event.propertyName !== "width") {
            return;
          }
          props.onExitComplete?.();
        }}
      >
        <div
          className={cn(
            "right-panel-inline-body right-panel-inline-surface flex h-full min-h-0 min-w-0 flex-col border-l border-border bg-background",
            maximized ? "relative w-full" : "absolute inset-y-0 right-0 w-(--right-panel-width)",
          )}
          onTransitionEnd={(event) => {
            if (
              open ||
              !maximized ||
              event.target !== event.currentTarget ||
              event.propertyName !== "translate"
            ) {
              return;
            }
            props.onExitComplete?.();
          }}
        >
          {panelContents}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-col self-stretch bg-background",
        "w-full",
      )}
      data-preview-panel-mode={props.mode}
      data-preview-panel-maximized={maximized ? "true" : "false"}
    >
      {panelContents}
    </div>
  );
}

/**
 * Track viewport width to derive a sensible upper bound for the panel.
 * Resize-aware so dragging the OS window narrower re-clamps the stored
 * width on the next render (the hook's clamp picks this up automatically).
 */
function useViewportClampedMaxWidth(): number {
  const [vw, setVw] = useState(() => (typeof window === "undefined" ? 1280 : window.innerWidth));
  useEffect(() => {
    if (typeof window === "undefined") return;
    let frame = 0;
    const onResize = () => {
      // Coalesce rapid resize events into one rAF tick.
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setVw(window.innerWidth);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);
  return getPreviewPanelMaxWidth(vw);
}
