import { useCallback, useLayoutEffect, useRef } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useSidebarVisibility } from "../ui/sidebar";

export function useSidebarActiveThreadScroll(input: {
  hasThreadRoute: boolean;
  routeThreadKey: string | null;
}) {
  const { hasThreadRoute, routeThreadKey } = input;
  const sidebarIsVisible = useSidebarVisibility();
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
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

    if (!hasThreadRoute) {
      initialScrollPendingRef.current = false;
    }
    const initialScrollPending = initialScrollPendingRef.current;

    if (!sidebarIsVisible) {
      sidebarWasVisibleRef.current = false;
      return;
    }
    if (!routeThreadKey) {
      sidebarWasVisibleRef.current = true;
      if (!hasThreadRoute) {
        lastRouteThreadKeyRef.current = null;
        sidebarNavigationThreadKeyRef.current = null;
      }
      return;
    }
    if (routeChangedFromSidebar) {
      sidebarWasVisibleRef.current = true;
      lastRouteThreadKeyRef.current = routeThreadKey;
      initialScrollPendingRef.current = false;
      sidebarNavigationThreadKeyRef.current = null;
      return;
    }
    if (!initialScrollPending && !sidebarBecameVisible && !routeThreadChanged) {
      sidebarWasVisibleRef.current = true;
      return;
    }

    const activeThread = document.querySelector<HTMLElement>(
      `[data-sidebar-thread-key="${globalThis.CSS.escape(routeThreadKey)}"]`,
    );
    if (!activeThread) return;

    activeThread.scrollIntoView({
      behavior:
        initialScrollPending || sidebarBecameVisible || prefersReducedMotion ? "instant" : "smooth",
      block: "center",
    });
    sidebarWasVisibleRef.current = true;
    lastRouteThreadKeyRef.current = routeThreadKey;
    initialScrollPendingRef.current = false;
    sidebarNavigationThreadKeyRef.current = null;
  });

  return markSidebarThreadNavigation;
}
