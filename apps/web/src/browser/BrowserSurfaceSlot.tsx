import { useLayoutEffect, useRef } from "react";

import { acquireBrowserSurface } from "./browserSurfaceStore";
import { observeResize } from "../lib/observeResize";

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
  const updateRef = useRef<(() => void) | null>(null);

  // The lease lives as long as this element for one tab, so the ref callback owns it.
  const attachSurface = (element: HTMLDivElement) => {
    let lease = acquireBrowserSurface(tabId, fitSourceContent);
    // An inline panel animates its clip box while the slot keeps its final size and position.
    const panel = element.closest<HTMLElement>("[data-preview-panel-clip]");
    let wasVisible = presentationRef.current.visible;
    let closing = false;
    const update = () => {
      const bounds = element.getBoundingClientRect();
      const presentation = presentationRef.current;
      if (presentation.visible !== wasVisible) {
        wasVisible = presentation.visible;
        // A close hides the slot in the same commit that marks the panel closed; stay on
        // screen while it slides away, like the DOM surfaces beside it.
        closing = !presentation.visible && panel?.dataset.previewPanelClip === "closed";
      }
      const rect = toSurfaceRect(bounds);
      const panelBounds = panel?.getBoundingClientRect();
      const visibleBounds = panelBounds ? intersectBounds(bounds, panelBounds) : bounds;
      // Unrounded, so the clip edge tracks the panel's fractional edge exactly.
      const clip = rectEquals(visibleBounds, bounds)
        ? null
        : {
            x: visibleBounds.x,
            y: visibleBounds.y,
            width: visibleBounds.width,
            height: visibleBounds.height,
          };
      const shown =
        (presentation.visible || closing) && visibleBounds.width > 0 && visibleBounds.height > 0;
      if (!shown) closing = false;
      const present = () =>
        lease.present(rect, shown, presentation.cornerRadius, presentation.zIndex, clip);
      if (!present() && presentation.visible) {
        lease.release();
        lease = acquireBrowserSurface(tabId, fitSourceContent);
        present();
      }
    };
    updateRef.current = update;
    update();
    const observed: Element[] = [element];
    if (panel) observed.push(panel);
    // Sidebar width changes move the slot without changing its size or column offset.
    observed.push(...document.querySelectorAll('[data-slot="sidebar-gap"]'));
    const stopObserving = observeResize(observed, update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      stopObserving();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      if (updateRef.current === update) updateRef.current = null;
      lease.release();
    };
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes visibility, radius and stacking to the desktop browser surface after layout
  useLayoutEffect(() => {
    presentationRef.current = { visible, cornerRadius, zIndex };
    updateRef.current?.();
  }, [
    cornerRadius,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A layoutVersion bump means the slot moved without resizing, so it re-presents at the new position.
    layoutVersion,
    visible,
    zIndex,
  ]);

  return <div ref={attachSurface} className={className} data-browser-surface-slot={tabId} />;
}

function toSurfaceRect(bounds: DOMRectReadOnly) {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}

function intersectBounds(a: DOMRectReadOnly, b: DOMRectReadOnly): DOMRectReadOnly {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return new DOMRectReadOnly(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}

const rectEquals = (a: DOMRectReadOnly, b: DOMRectReadOnly) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
