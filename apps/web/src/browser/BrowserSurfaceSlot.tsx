"use client";

import { useLayoutEffect, useRef } from "react";

import { acquireBrowserSurface } from "./browserSurfaceStore";

export function BrowserSurfaceSlot(props: {
  readonly tabId: string;
  readonly visible: boolean;
  readonly cornerRadius?: number;
  readonly layoutVersion?: string | number;
  readonly className?: string;
}) {
  const { tabId, visible, cornerRadius = 0, layoutVersion, className } = props;
  const elementRef = useRef<HTMLDivElement | null>(null);
  const presentationRef = useRef({ visible, cornerRadius });
  const updateRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const lease = acquireBrowserSurface(tabId);
    const update = () => {
      const rect = element.getBoundingClientRect();
      const presentation = presentationRef.current;
      lease.present(
        {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height)),
        },
        presentation.visible && rect.width > 0 && rect.height > 0,
        presentation.cornerRadius,
      );
    };
    updateRef.current = update;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      if (updateRef.current === update) updateRef.current = null;
      lease.release();
    };
  }, [tabId]);

  useLayoutEffect(() => {
    presentationRef.current = { visible, cornerRadius };
    updateRef.current?.();
  }, [cornerRadius, layoutVersion, visible]);

  return <div ref={elementRef} className={className} data-browser-surface-slot={tabId} />;
}
