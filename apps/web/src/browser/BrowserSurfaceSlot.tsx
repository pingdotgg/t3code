import { useLayoutEffect, useRef } from "react";

import { observeResize } from "../lib/observeResize";
import { acquireBrowserSurface, type BrowserSurfacePlacement } from "./browserSurfaceStore";
import {
  type BrowserSurfaceSlotPhase,
  kickBrowserSurfaceTracking,
  trackBrowserSurfaceSlot,
} from "./browserSurfaceTracking";

/** An ancestor that clips the slot: its pane, the strip, the overview's frame. */
interface ClipAncestor {
  readonly element: Element;
  /** Corner radii in its own pixels: top-left, top-right, bottom-right, bottom-left. */
  readonly radii: readonly [number, number, number, number];
}

function clipAncestorsOf(element: HTMLElement): ClipAncestor[] {
  const ancestors: ClipAncestor[] = [];
  for (
    let node = element.parentElement;
    node && node !== document.body;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    ancestors.push({
      element: node,
      radii: [
        parseFloat(style.borderTopLeftRadius) || 0,
        parseFloat(style.borderTopRightRadius) || 0,
        parseFloat(style.borderBottomRightRadius) || 0,
        parseFloat(style.borderBottomLeftRadius) || 0,
      ],
    });
  }
  return ancestors;
}

const near = (value: number, edges: readonly number[]) =>
  edges.some((edge) => Math.abs(edge - value) < 1);

/**
 * The part of the slot its ancestors leave visible, as a `clip-path` in the
 * slot's own pixels. A corner that meets a rounded pane's corner, or where
 * the strip's edge cuts that pane (index.css, [data-pane-cut]), rounds as
 * the pane does.
 */
function resolveClipPath(rect: DOMRect, scale: number, ancestors: readonly ClipAncestor[]) {
  const boxes = ancestors.map((ancestor) => ancestor.element.getBoundingClientRect());
  let left = rect.left;
  let top = rect.top;
  let right = rect.right;
  let bottom = rect.bottom;
  for (const box of boxes) {
    left = Math.max(left, box.left);
    top = Math.max(top, box.top);
    right = Math.min(right, box.right);
    bottom = Math.min(bottom, box.bottom);
  }
  if (right - left < 1 || bottom - top < 1) return "inset(50%)";
  const corners = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ] as const;
  const radii = corners.map(([x, y], corner) => {
    let radius = 0;
    ancestors.forEach((ancestor, index) => {
      const own = ancestor.radii[corner]!;
      if (own <= 0) return;
      const box = boxes[index]!;
      const outer = boxes.slice(index + 1);
      const xs = [box.left, box.right, ...outer.flatMap((edge) => [edge.left, edge.right])];
      const ys = [box.top, box.bottom, ...outer.flatMap((edge) => [edge.top, edge.bottom])];
      if (!near(x, xs) || !near(y, ys)) return;
      const ownScale = box.width / Math.max(1, (ancestor.element as HTMLElement).offsetWidth || 1);
      radius = Math.max(radius, own * ownScale);
    });
    return radius / scale;
  });
  const insets = [top - rect.top, rect.right - right, rect.bottom - bottom, left - rect.left].map(
    (inset) => Math.max(0, inset / scale),
  );
  if (insets.every((inset) => inset < 0.5) && radii.every((radius) => radius === 0)) return "";
  const round = radii.some((radius) => radius > 0)
    ? ` round ${radii.map((radius) => `${radius}px`).join(" ")}`
    : "";
  return `inset(${insets.map((inset) => `${inset}px`).join(" ")}${round})`;
}

export function BrowserSurfaceSlot(props: {
  readonly tabId: string;
  readonly visible: boolean;
  readonly cornerRadius?: number;
  readonly zIndex?: number;
  readonly layoutVersion?: string | number;
  readonly className?: string;
  readonly fitSourceContent?: boolean;
}) {
  const {
    tabId,
    visible,
    cornerRadius = 0,
    zIndex = 30,
    layoutVersion,
    className,
    fitSourceContent = false,
  } = props;
  const presentationRef = useRef({ visible, cornerRadius, zIndex });
  const updateRef = useRef<((phase: BrowserSurfaceSlotPhase) => boolean) | null>(null);

  // The lease lives as long as this element for one tab, so the ref callback owns it.
  const attachSurface = (element: HTMLDivElement) => {
    let lease = acquireBrowserSurface(tabId, fitSourceContent);
    let ancestors = clipAncestorsOf(element);
    let presented = "";
    let placed: BrowserSurfacePlacement | null = null;
    // The webview keeps the slot's own size and follows it on screen with a
    // transform, so a pane sliding or zooming never resizes the page.
    const update = (phase: BrowserSurfaceSlotPhase) => {
      const rect = element.getBoundingClientRect();
      const width = Math.max(1, element.offsetWidth);
      const height = Math.max(1, element.offsetHeight);
      const presentation = presentationRef.current;
      const shown = presentation.visible && element.offsetWidth > 0 && element.offsetHeight > 0;
      if (phase !== "frame") ancestors = clipAncestorsOf(element);
      const key = `${width}:${height}:${shown}:${presentation.cornerRadius}:${presentation.zIndex}`;
      // Position alone reaches the store once it settles; size and visibility at once.
      if (key !== presented || phase !== "frame") {
        const box = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width,
          height,
        };
        if (!lease.present(box, shown, presentation.cornerRadius, presentation.zIndex)) {
          // Another slot took the tab (the mini player); a visible one takes it back,
          // but not every frame, so two never trade it back and forth.
          if (!shown || phase === "frame") return false;
          lease.release();
          lease = acquireBrowserSurface(tabId, fitSourceContent);
          lease.present(box, shown, presentation.cornerRadius, presentation.zIndex);
        }
        presented = key;
      }
      const scale = rect.width / width;
      const next: BrowserSurfacePlacement = {
        x: rect.x,
        y: rect.y,
        scale,
        clipPath: resolveClipPath(rect, scale, ancestors),
        // Under the overview or off the focused workspace mid-switch the pane is inert.
        interactive: element.closest("[inert]") === null,
      };
      const moved =
        placed === null ||
        Math.abs(placed.x - next.x) > 0.01 ||
        Math.abs(placed.y - next.y) > 0.01 ||
        Math.abs(placed.scale - next.scale) > 0.0001 ||
        placed.clipPath !== next.clipPath ||
        placed.interactive !== next.interactive;
      if (moved || phase !== "frame") lease.place(next);
      placed = next;
      return moved;
    };
    updateRef.current = update;
    update("start");
    const stopTracking = trackBrowserSurfaceSlot(element, update);
    const observed: Element[] = [element];
    // Inline shells animate without resizing the slot, so observe the shell too.
    const panel = element.closest('[data-preview-panel-mode="inline"]');
    if (panel) observed.push(panel);
    // Sidebar width changes move the slot without changing its size or column offset.
    observed.push(...document.querySelectorAll('[data-slot="sidebar-gap"]'));
    const stopObserving = observeResize(observed, () => {
      update("start");
      kickBrowserSurfaceTracking();
    });
    return () => {
      stopObserving();
      stopTracking();
      if (updateRef.current === update) updateRef.current = null;
      lease.release();
    };
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes visibility, radius and stacking to the desktop browser surface after layout
  useLayoutEffect(() => {
    presentationRef.current = { visible, cornerRadius, zIndex };
    updateRef.current?.("start");
  }, [
    cornerRadius,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A layoutVersion bump means the slot moved without resizing, so it re-presents at the new position.
    layoutVersion,
    visible,
    zIndex,
  ]);

  return <div ref={attachSurface} className={className} data-browser-surface-slot={tabId} />;
}
