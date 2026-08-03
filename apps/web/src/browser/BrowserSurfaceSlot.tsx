"use client";

import { useLayoutEffect, useRef } from "react";

import { acquireBrowserSurface } from "./browserSurfaceStore";

export function BrowserSurfaceSlot(props: {
  readonly tabId: string;
  readonly visible: boolean;
  /** Re-publishes a position-only layout change such as a floating-player drag. */
  readonly layoutVersion?: string | number | undefined;
  readonly className?: string;
}) {
  const { tabId, visible, layoutVersion, className } = props;
  const elementRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const lease = acquireBrowserSurface(tabId);
    const update = () => {
      const rect = element.getBoundingClientRect();
      lease.present(
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
      lease.release();
    };
  }, [layoutVersion, tabId, visible]);

  return <div ref={elementRef} className={className} data-browser-surface-slot={tabId} />;
}
