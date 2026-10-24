import { type RefObject, useLayoutEffect, useState } from "react";

import { type ResizableWidthHandlers, useResizableWidth } from "./useResizableWidth";
import { observeResize } from "../lib/observeResize";

export interface PreviewPanelInlineSize {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
}

const PREVIEW_PANEL_WIDTH_STORAGE_KEY = "t3code:preview-panel-width";
const PREVIEW_PANEL_MIN_WIDTH = 360;
const PREVIEW_PANEL_MAX_WIDTH_FRACTION = 0.7;
/**
 * Floor for the column beside the panel: below this the chat column's
 * composer overflows, so the panel yields instead.
 */
const SIBLING_COLUMN_MIN_WIDTH = 360;
const PREVIEW_PANEL_DEFAULT_WIDTH = 540;

export function usePreviewPanelInlineSize(
  hostRef?: RefObject<HTMLElement | null>,
  options: {
    readonly enabled?: boolean | undefined;
    readonly widthStorageKey?: string | undefined;
    readonly defaultWidth?: number | undefined;
    readonly balancedDefault?: boolean | undefined;
    readonly container?: HTMLElement | null | undefined;
  } = {},
): PreviewPanelInlineSize {
  const { maxWidth, availableWidth } = useViewportClampedMaxWidth(
    hostRef,
    options.enabled ?? true,
    options.container,
    options.balancedDefault === true,
  );
  return useResizableWidth({
    storageKey: options.widthStorageKey ?? PREVIEW_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: options.balancedDefault
      ? Math.floor(availableWidth / 2)
      : (options.defaultWidth ?? PREVIEW_PANEL_DEFAULT_WIDTH),
    minWidth: PREVIEW_PANEL_MIN_WIDTH,
    maxWidth,
    edge: "left",
  });
}

function useViewportClampedMaxWidth(
  hostRef: RefObject<HTMLElement | null> | undefined,
  enabled: boolean,
  container: HTMLElement | null | undefined,
  balancedDefault: boolean,
): { maxWidth: number; availableWidth: number } {
  const [size, setSize] = useState(() => {
    const availableWidth = typeof window === "undefined" ? 1280 : window.innerWidth;
    return { maxWidth: getPreviewPanelMaxWidth(availableWidth), availableWidth };
  });
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const row = container ?? (enabled ? hostRef?.current?.parentElement : null) ?? null;
    // Measure before first paint: the persisted width must be clamped against
    // the row on the initial render, not one observer tick later (the panel
    // would flash over-wide on every mount). Track row width for a balanced
    // split only; ordinary panels still skip renders while the
    // sidebar drags without changing their maximum.
    const measure = () => {
      const measuredWidth = row?.clientWidth ?? window.innerWidth;
      const maxWidth = getPreviewPanelMaxWidth(window.innerWidth, row?.clientWidth);
      setSize((current) => {
        const availableWidth = balancedDefault ? measuredWidth : current.availableWidth;
        return current.maxWidth === maxWidth && current.availableWidth === availableWidth
          ? current
          : { maxWidth, availableWidth };
      });
    };
    measure();
    let frame = 0;
    const onResize = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    window.addEventListener("resize", onResize);
    const stopObserving = row ? observeResize(row, measure) : undefined;
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      stopObserving?.();
    };
  }, [container, hostRef, enabled, balancedDefault]);
  return size;
}
function getPreviewPanelMaxWidth(viewportWidth: number, containerWidth?: number): number {
  const fractionCap = Math.floor(viewportWidth * PREVIEW_PANEL_MAX_WIDTH_FRACTION);
  const containerCap =
    containerWidth === undefined ? Infinity : Math.floor(containerWidth) - SIBLING_COLUMN_MIN_WIDTH;
  // Never below the panel's own minimum: when the row cannot fit both
  // columns' minimums the sibling yields, and useResizableWidth's clamp must
  // not see max < min (it would resolve the inversion to min and, via
  // drag-end persistence, overwrite the user's stored width).
  return Math.max(PREVIEW_PANEL_MIN_WIDTH, Math.min(fractionCap, containerCap));
}
