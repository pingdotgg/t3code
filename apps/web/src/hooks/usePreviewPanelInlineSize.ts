import { type RefObject, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";

import { type ResizableWidthHandlers, useResizableWidth } from "./useResizableWidth";

export interface PreviewPanelInlineSize {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
}

const PREVIEW_PANEL_WIDTH_STORAGE_KEY = "t3code:preview-panel-width";
const PREVIEW_PANEL_MIN_WIDTH = 360;
/**
 * Width reserved for the sibling column (chat, pull-request list) sharing the
 * panel's flex row; below this the chat column's composer overflows. This is
 * the only upper bound on the panel, so the chat keeps the same minimum
 * whether or not the app sidebar is open. A cap based on the viewport would
 * ignore the sidebar and bind only once it collapses.
 */
const SIBLING_COLUMN_MIN_WIDTH = 360;
const PREVIEW_PANEL_DEFAULT_WIDTH = 540;

export function usePreviewPanelInlineSize(
  hostRef?: RefObject<HTMLElement | null>,
  options: {
    /** False in modes that never apply the inline width (sheet, maximized). */
    readonly enabled?: boolean | undefined;
    /** A closed panel leaves the whole row to its sibling, so it stops tracking the row. */
    readonly open?: boolean | undefined;
    readonly widthStorageKey?: string | undefined;
    readonly defaultWidth?: number | undefined;
    /** Use the caller's existing row measurement instead of observing the panel's parent. */
    readonly containerWidth?: number | undefined;
  } = {},
): PreviewPanelInlineSize {
  const enabled = options.enabled ?? true;
  const measuredRowWidth = useRowWidth(hostRef, enabled);
  const rowWidth = options.containerWidth ?? measuredRowWidth;
  return useResizableWidth({
    storageKey: options.widthStorageKey ?? PREVIEW_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: options.defaultWidth ?? PREVIEW_PANEL_DEFAULT_WIDTH,
    minWidth: PREVIEW_PANEL_MIN_WIDTH,
    // Unmeasured only before the first layout effect or in modes that never
    // apply the width; the viewport is an upper bound on the row.
    maxWidth: getPreviewPanelMaxWidth(
      rowWidth ?? (typeof window === "undefined" ? 1280 : window.innerWidth),
    ),
    // An open inline panel absorbs row changes (window resize, app sidebar
    // toggle) so its sibling keeps its width. Closed or maximized panels stop
    // tracking and restart from a fresh baseline.
    rowWidth: enabled && (options.open ?? true) ? rowWidth : undefined,
    edge: "left",
  });
}

/**
 * Track the flex-row width the panel shares with its sibling column. The row
 * is observed rather than the panel itself because the panel competes with
 * its sibling for row space. Measurement only runs when `enabled`; modes
 * without a resize handle never apply the resulting width.
 */
function useRowWidth(
  hostRef: RefObject<HTMLElement | null> | undefined,
  enabled: boolean,
): number | undefined {
  const [rowWidth, setRowWidth] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!enabled) return;
    const parent = hostRef?.current?.parentElement;
    if (!parent) return;
    // Measure before first paint: the persisted width must be clamped against
    // the row on the initial render, not one observer tick later (the panel
    // would flash over-wide on every mount). clientWidth is integral, so
    // sub-pixel resize deltas bail out of re-rendering.
    const measure = () => {
      setRowWidth(parent.clientWidth);
    };
    measure();
    // Flush in the observer's pre-paint slot: the app sidebar animates its
    // width, and a panel that caught up a frame late would wobble the chat.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            flushSync(measure);
          });
    observer?.observe(parent);
    return () => {
      observer?.disconnect();
      // Tracking restarts from a fresh baseline, not a width from before.
      setRowWidth(undefined);
    };
  }, [hostRef, enabled]);
  return rowWidth;
}

export function getPreviewPanelMaxWidth(rowWidth: number): number {
  // Never below the panel's own minimum: when the row cannot fit both
  // columns' minimums the sibling yields, and useResizableWidth's clamp must
  // not see max < min (it would resolve the inversion to min and, via
  // drag-end persistence, overwrite the user's stored width).
  return Math.max(PREVIEW_PANEL_MIN_WIDTH, Math.floor(rowWidth) - SIBLING_COLUMN_MIN_WIDTH);
}
