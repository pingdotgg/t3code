import { useCallback, useLayoutEffect, useRef } from "react";

import { useSidebar } from "../ui/sidebar";

export function useSidebarActiveThreadScroll(routeThreadKey: string | null) {
  const { isMobile, open, openMobile } = useSidebar();
  const sidebarIsVisible = isMobile ? openMobile : open;
  const sidebarWasVisibleRef = useRef(false);
  const lastRouteThreadKeyRef = useRef(routeThreadKey);
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
      (!sidebarBecameVisible && (!routeThreadChanged || routeChangedFromSidebar))
    ) {
      return;
    }

    document
      .querySelector<HTMLElement>(
        `[data-sidebar-thread-key="${globalThis.CSS.escape(routeThreadKey)}"]`,
      )
      ?.scrollIntoView({
        behavior: sidebarBecameVisible ? "instant" : "smooth",
        block: "center",
      });
  }, [routeThreadKey, sidebarIsVisible]);

  return markSidebarThreadNavigation;
}
