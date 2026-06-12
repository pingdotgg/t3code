"use client";

import { useEffect, useRef } from "react";

import { useBrowserSurfaceStore } from "./browserSurfaceStore";

export function BrowserSurfaceSlot(props: {
  readonly tabId: string;
  readonly visible: boolean;
  readonly className?: string;
}) {
  const { tabId, visible, className } = props;
  const elementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      useBrowserSurfaceStore.getState().present(
        tabId,
        {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height)),
        },
        visible && rect.width > 0 && rect.height > 0,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      useBrowserSurfaceStore.getState().hide(tabId);
    };
  }, [tabId, visible]);

  return <div ref={elementRef} className={className} data-browser-surface-slot={tabId} />;
}
