import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";

import { flushSync } from "react-dom";

import { useResizableWidth } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

import { RightPanelResizeHandle } from "./RightPanelResizeHandle";

export type PreviewPanelMode = "inline" | "sheet" | "sidebar" | "embedded";

const PREVIEW_PANEL_WIDTH_STORAGE_KEY = "t3code:preview-panel-width";
const PREVIEW_PANEL_MIN_WIDTH = 360;
const PREVIEW_PANEL_DEFAULT_WIDTH = 540;
/**
 * Width reserved for the sibling column (chat, pull-request list) sharing the
 * panel's flex row. This is the only upper bound on the panel, so the chat
 * keeps the same minimum whether or not the app sidebar is open. A cap based
 * on the viewport would ignore the sidebar and bind only once it collapses.
 */
const SIBLING_COLUMN_MIN_WIDTH = 360;

export function getPreviewPanelMaxWidth(rowWidth: number): number {
  // Never below the panel's own minimum: when the row cannot fit both
  // columns' minimums the sibling yields, and useResizableWidth's clamp
  // must not see max < min (it would resolve the inversion to min and,
  // via drag-end persistence, overwrite the user's stored width).
  return Math.max(PREVIEW_PANEL_MIN_WIDTH, Math.floor(rowWidth) - SIBLING_COLUMN_MIN_WIDTH);
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
  /**
   * Overrides the localStorage key used to persist the panel width. Callers
   * embedding this shell for a different surface (e.g. the pull requests
   * page) should pass their own key so resizing one panel doesn't clobber
   * the other's remembered width.
   */
  widthStorageKey?: string;
  /** Overrides the initial width (px) before the user has resized the panel. */
  defaultWidth?: number;
  children: ReactNode;
}) {
  const isInline = props.mode === "inline";
  const collapsible = isInline && props.open !== undefined;
  const open = props.open ?? true;
  const maximized = props.maximized ?? false;
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Only inline non-maximized mode applies `width`/`maxWidth`; skip the
  // row measurement (and its re-renders) everywhere else.
  const rowWidth = useRowWidth(hostRef, isInline && !maximized);
  const { width, handlers } = useResizableWidth({
    storageKey: props.widthStorageKey ?? PREVIEW_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: props.defaultWidth ?? PREVIEW_PANEL_DEFAULT_WIDTH,
    minWidth: PREVIEW_PANEL_MIN_WIDTH,
    // Unmeasured only before the first layout effect or in modes that never
    // apply the width; the viewport is an upper bound on the row.
    maxWidth: getPreviewPanelMaxWidth(
      rowWidth ?? (typeof window === "undefined" ? 1280 : window.innerWidth),
    ),
    // A closed panel leaves the whole row to its sibling, so only an open one
    // keeps the sibling's width steady.
    rowWidth: open ? rowWidth : undefined,
    edge: "left",
  });
  // Derive suppression before the layout commits so the browser never creates
  // a width transition for resize or maximize changes.
  const [layoutTransition, setLayoutTransition] = useState(() => ({
    open,
    width,
    maximized,
    suppressed: false,
  }));
  if (
    layoutTransition.open !== open ||
    layoutTransition.width !== width ||
    layoutTransition.maximized !== maximized
  ) {
    setLayoutTransition({
      open,
      width,
      maximized,
      suppressed:
        collapsible &&
        layoutTransition.open === open &&
        (layoutTransition.width !== width || layoutTransition.maximized !== maximized),
    });
  }
  const suppressWidthTransition = layoutTransition.suppressed;
  useLayoutEffect(() => {
    if (!suppressWidthTransition) return;
    let restoreFrame = 0;
    const paintFrame = window.requestAnimationFrame(() => {
      restoreFrame = window.requestAnimationFrame(() => {
        setLayoutTransition((current) => ({ ...current, suppressed: false }));
      });
    });
    return () => {
      window.cancelAnimationFrame(paintFrame);
      window.cancelAnimationFrame(restoreFrame);
    };
  }, [suppressWidthTransition]);
  return (
    <div
      ref={hostRef}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 max-w-full flex-col self-stretch bg-background",
        isInline
          ? maximized
            ? "flex-1 border-l border-border"
            : "shrink-0 border-l border-border"
          : "w-full",
        collapsible &&
          "[[data-panel-animations=true]_&]:transition-[width] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-out",
        collapsible && open && "[[data-panel-animations=true]_&]:starting:w-0!",
        collapsible && !open && "pointer-events-none",
      )}
      style={
        isInline
          ? {
              width: maximized ? "100%" : collapsible && !open ? "0px" : `${width}px`,
              transitionDuration: suppressWidthTransition ? "0ms" : undefined,
            }
          : undefined
      }
      data-preview-panel-mode={props.mode}
      data-preview-panel-maximized={maximized ? "true" : "false"}
    >
      {isInline && !maximized ? <RightPanelResizeHandle handlers={handlers} /> : null}
      <div className={cn("h-full min-h-0 w-full", collapsible && "overflow-clip")}>
        <div
          className="flex h-full min-h-0 min-w-0 flex-col"
          style={collapsible && !maximized ? { width: `calc(${width}px - 1px)` } : undefined}
        >
          {props.children}
        </div>
      </div>
    </div>
  );
}

/**
 * Track the flex-row width the panel shares with its sibling column. It
 * bounds the panel and lets an open panel absorb row changes (window resize,
 * app sidebar toggle) so the sibling keeps its width. The row is observed
 * rather than the panel itself because the panel competes with its sibling
 * for row space. Measurement only runs when `enabled`; modes without a resize
 * handle never apply the resulting width, so they skip the observer entirely.
 */
function useRowWidth(
  hostRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
): number | undefined {
  const [rowWidth, setRowWidth] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!enabled) return;
    const parent = hostRef.current?.parentElement;
    if (!parent) return;
    // Measure before first paint: the persisted width must be clamped
    // against the row on the initial render, not one observer tick later
    // (the panel would flash over-wide on every mount). clientWidth is
    // integral, so sub-pixel resize deltas bail out of re-rendering.
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
