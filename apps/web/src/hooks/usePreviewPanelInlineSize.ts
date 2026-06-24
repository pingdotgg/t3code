import { useEffect, useState } from "react";

import { type ResizableWidthHandlers, useResizableWidth } from "./useResizableWidth";

export interface PreviewPanelInlineSize {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
}

const PREVIEW_PANEL_WIDTH_STORAGE_KEY = "t3code:preview-panel-width";
const PREVIEW_PANEL_MIN_WIDTH = 360;
/** Hard ceiling so a wide monitor can't yield a panel that swallows the chat. */
const PREVIEW_PANEL_MAX_WIDTH_PX = 1400;
/** Fraction of the viewport allowed; the panel is min(this · vw, MAX_PX). */
const PREVIEW_PANEL_MAX_WIDTH_FRACTION = 0.7;
const PREVIEW_PANEL_DEFAULT_WIDTH = 540;

export function usePreviewPanelInlineSize(): PreviewPanelInlineSize {
  const maxWidth = useViewportClampedMaxWidth();
  return useResizableWidth({
    storageKey: PREVIEW_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: PREVIEW_PANEL_DEFAULT_WIDTH,
    minWidth: PREVIEW_PANEL_MIN_WIDTH,
    maxWidth,
    edge: "left",
  });
}

/** Keep the resizable panel's upper bound in sync with the current window. */
function useViewportClampedMaxWidth(): number {
  const [vw, setVw] = useState(() => (typeof window === "undefined" ? 1280 : window.innerWidth));
  useEffect(() => {
    if (typeof window === "undefined") return;
    let frame = 0;
    const onResize = () => {
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
  return Math.min(PREVIEW_PANEL_MAX_WIDTH_PX, Math.floor(vw * PREVIEW_PANEL_MAX_WIDTH_FRACTION));
}
