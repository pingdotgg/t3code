import { useEffect, useRef, useState } from "react";

import { useBottomDrawerUiStore } from "../bottomDrawerUiStore";
import { cn } from "~/lib/utils";
import { PreviewDrawer } from "./PreviewDrawer";

export function BottomDrawerHost() {
  const visibleMode = useBottomDrawerUiStore((state) => state.visibleMode);
  const fullHeight = useBottomDrawerUiStore((state) => state.isFullHeight);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [overlayTop, setOverlayTop] = useState(0);

  useEffect(() => {
    if (!fullHeight || visibleMode === "hidden") {
      setOverlayTop(0);
      return;
    }

    const updateOverlayTop = () => {
      const host = hostRef.current;
      const parent = host?.parentElement;
      if (!host || !parent) {
        setOverlayTop(0);
        return;
      }
      const parentRect = parent.getBoundingClientRect();
      const anchor = parent.querySelector<HTMLElement>("[data-bottom-drawer-anchor='true']");
      if (!anchor) {
        setOverlayTop(0);
        return;
      }
      const anchorRect = anchor.getBoundingClientRect();
      setOverlayTop(Math.max(0, Math.round(anchorRect.top - parentRect.top)));
    };

    updateOverlayTop();
    window.addEventListener("resize", updateOverlayTop);
    return () => {
      window.removeEventListener("resize", updateOverlayTop);
    };
  }, [fullHeight, visibleMode]);

  if (visibleMode === "hidden") {
    return null;
  }

  return (
    <div
      ref={hostRef}
      className={cn(fullHeight ? "absolute inset-x-0 bottom-0 z-40 min-h-0" : "shrink-0")}
      style={fullHeight ? { top: `${overlayTop}px` } : undefined}
    >
      {visibleMode === "preview" ? <PreviewDrawer /> : null}
    </div>
  );
}
