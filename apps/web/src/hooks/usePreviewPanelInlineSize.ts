import { useState } from "react";

import { type ResizableWidthHandlers, useResizableWidth } from "./useResizableWidth";
import { observeResize } from "../lib/observeResize";

export interface PreviewPanelInlineSize {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
  /** Ref-callback body for the panel host: measures the row the panel shares. */
  readonly observeRow: (host: HTMLElement) => () => void;
}

const PREVIEW_PANEL_WIDTH_STORAGE_KEY = "t3code:preview-panel-width";
const PREVIEW_PANEL_MIN_WIDTH = 360;
const PREVIEW_PANEL_MAX_WIDTH_FRACTION = 0.7;
/** Below this, the sibling chat column's composer overflows. */
const SIBLING_COLUMN_MIN_WIDTH = 360;
const PREVIEW_PANEL_DEFAULT_WIDTH = 540;

export function usePreviewPanelInlineSize(
  options: {
    readonly enabled?: boolean | undefined;
    readonly widthStorageKey?: string | undefined;
    readonly defaultWidth?: number | undefined;
    readonly preferredSiblingWidth?: number | undefined;
    readonly container?: HTMLElement | null | undefined;
  } = {},
): PreviewPanelInlineSize {
  const enabled = options.enabled ?? true;
  const container = options.container;
  const [availableWidth, setAvailableWidth] = useState(PREVIEW_PANEL_DEFAULT_WIDTH);
  const [maxWidth, setMaxWidth] = useState(() =>
    getPreviewPanelMaxWidth(typeof window === "undefined" ? 1280 : window.innerWidth),
  );
  const { width, handlers } = useResizableWidth({
    storageKey: options.widthStorageKey ?? PREVIEW_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: options.defaultWidth ?? availableWidth,
    minWidth: PREVIEW_PANEL_MIN_WIDTH,
    maxWidth,
    edge: "left",
  });
  const observeRow = (host: HTMLElement) => {
    const row = container ?? (enabled ? host.parentElement : null) ?? null;
    // Ref callbacks run before paint, so the width is clamped without an over-wide
    // flash on mount. Store only derived widths so unchanged bounds and defaults
    // skip re-rendering the owner during a sidebar drag.
    const measure = () => {
      setMaxWidth(getPreviewPanelMaxWidth(window.innerWidth, row?.clientWidth));
      setAvailableWidth(
        Math.max(
          PREVIEW_PANEL_DEFAULT_WIDTH,
          Math.floor(row?.clientWidth ?? 0) - (options.preferredSiblingWidth ?? Infinity),
        ),
      );
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
  };
  return { width, handlers, observeRow };
}

function getPreviewPanelMaxWidth(viewportWidth: number, containerWidth?: number): number {
  const fractionCap = Math.floor(viewportWidth * PREVIEW_PANEL_MAX_WIDTH_FRACTION);
  const containerCap =
    containerWidth === undefined ? Infinity : Math.floor(containerWidth) - SIBLING_COLUMN_MIN_WIDTH;
  // Keep max >= min; an inverted clamp would overwrite the saved width on drag end.
  return Math.max(PREVIEW_PANEL_MIN_WIDTH, Math.min(fractionCap, containerCap));
}
