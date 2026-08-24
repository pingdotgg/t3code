import { useCallback, useLayoutEffect, useRef } from "react";

import { useSidebar } from "../ui/sidebar";

export function useSidebarActiveThreadScroll(
  routeThreadKey: string | null,
  sidebarThreadCount: number,
) {
  const { isMobile, open, openMobile } = useSidebar();
  const sidebarIsVisible = isMobile ? openMobile : open;
  const sidebarWasVisibleRef = useRef(false);
  const lastRouteThreadKeyRef = useRef(routeThreadKey);
  const initialScrollPendingRef = useRef(true);
  const sidebarNavigationThreadKeyRef = useRef<string | null>(null);

  const markSidebarThreadNavigation = useCallback((threadKey: string) => {
    sidebarNavigationThreadKeyRef.current = threadKey;
  }, []);

  useLayoutEffect(() => {
    const sidebarBecameVisible = sidebarIsVisible && !sidebarWasVisibleRef.current;
    const routeThreadChanged =
      routeThreadKey !== null && lastRouteThreadKeyRef.current !== routeThreadKey;
    const routeChangedFromSidebar =
      routeThreadChanged && sidebarNavigationThreadKeyRef.current === routeThreadKey;
    const initialScrollPending = initialScrollPendingRef.current;

    sidebarWasVisibleRef.current = sidebarIsVisible;
    if (routeThreadKey !== null) {
      lastRouteThreadKeyRef.current = routeThreadKey;
    }
    if (routeThreadChanged) {
      sidebarNavigationThreadKeyRef.current = null;
    }

    if (
      !sidebarIsVisible ||
      !routeThreadKey ||
      (!initialScrollPending &&
        !sidebarBecameVisible &&
        (!routeThreadChanged || routeChangedFromSidebar))
    ) {
      return;
    }

    const activeThread = document.querySelector<HTMLElement>(
      `[data-sidebar-thread-key="${globalThis.CSS.escape(routeThreadKey)}"]`,
    );
    if (!activeThread) {
      return;
    }

    const behavior = initialScrollPending || sidebarBecameVisible ? "instant" : "smooth";
    initialScrollPendingRef.current = false;
    activeThread.scrollIntoView({
      behavior,
      block: "center",
    });
  }, [routeThreadKey, sidebarIsVisible, sidebarThreadCount]);

  return markSidebarThreadNavigation;
}
