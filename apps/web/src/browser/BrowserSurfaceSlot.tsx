"use client";

import { useLayoutEffect, useRef } from "react";

import { acquireBrowserSurface, useBrowserSurfaceStore } from "./browserSurfaceStore";

export function BrowserSurfaceSlot(props: {
  readonly tabId: string;
  readonly visible: boolean;
  readonly cornerRadius?: number | undefined;
  /** Re-publishes a position-only layout change such as a floating-player drag. */
  readonly layoutVersion?: string | number | undefined;
  readonly className?: string;
  /** Preserves the full source viewport when placing it in a smaller surface. */
  readonly fitSourceContent?: boolean | undefined;
}) {
  const {
    tabId,
    visible,
    cornerRadius = 0,
    layoutVersion,
    className,
    fitSourceContent = false,
  } = props;
  const elementRef = useRef<HTMLDivElement | null>(null);
  const presentationRef = useRef({ visible, cornerRadius });
  const updateRef = useRef<(() => void) | null>(null);
  const ownerRef = useRef<symbol | null>(null);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let lease = acquireBrowserSurface(tabId, fitSourceContent);
    ownerRef.current = useBrowserSurfaceStore.getState().byTabId[tabId]?.owner ?? null;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const presentation = presentationRef.current;
      const presented = lease.present(
        {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height)),
        },
        presentation.visible && rect.width > 0 && rect.height > 0,
        presentation.cornerRadius,
      );
      if (presentation.visible && !presented) {
        lease.release();
        lease = acquireBrowserSurface(tabId, fitSourceContent);
        ownerRef.current = useBrowserSurfaceStore.getState().byTabId[tabId]?.owner ?? null;
        lease.present(
          {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height)),
          },
          rect.width > 0 && rect.height > 0,
          presentation.cornerRadius,
        );
      } else {
        ownerRef.current = useBrowserSurfaceStore.getState().byTabId[tabId]?.owner ?? null;
      }
    };
    updateRef.current = update;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const unsubscribe = useBrowserSurfaceStore.subscribe((state) => {
      const currentOwner = state.byTabId[tabId]?.owner ?? null;
      if (currentOwner === ownerRef.current) return;
      // Another slot claimed this tab. Reclaim immediately when this slot is visible.
      if (presentationRef.current.visible) update();
      else ownerRef.current = currentOwner;
    });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      unsubscribe();
      if (updateRef.current === update) updateRef.current = null;
      ownerRef.current = null;
      lease.release();
    };
  }, [fitSourceContent, tabId]);

  useLayoutEffect(() => {
    presentationRef.current = { visible, cornerRadius };
    updateRef.current?.();
  }, [cornerRadius, layoutVersion, visible]);

  return <div ref={elementRef} className={className} data-browser-surface-slot={tabId} />;
}
