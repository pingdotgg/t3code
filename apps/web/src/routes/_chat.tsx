import { Outlet, createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  resolveSettingsToggleNavigation,
  SETTINGS_ROUTE_PATH,
  type SettingsToggleLocationSnapshot,
} from "../settingsToggle";
import {
  markPendingSettingsScrollRestore,
  resolveSettingsScrollRestoreThreadId,
} from "../settingsScrollRestore";
import ThreadSidebar from "../components/Sidebar";
import { Sidebar, SidebarProvider } from "~/components/ui/sidebar";

function ChatRouteLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const previousSettingsLocationRef = useRef<SettingsToggleLocationSnapshot | null>(null);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      const currentHref = window.location.hash.length > 0 ? window.location.hash : "#/";
      const nextNavigation = resolveSettingsToggleNavigation({
        pathname,
        href: currentHref,
        previousLocation: previousSettingsLocationRef.current,
      });
      previousSettingsLocationRef.current = nextNavigation.previousLocation;

      if (nextNavigation.destination === "settings") {
        void navigate({ to: SETTINGS_ROUTE_PATH });
        return;
      }

      if (nextNavigation.restoreHref !== null) {
        markPendingSettingsScrollRestore(
          resolveSettingsScrollRestoreThreadId(nextNavigation.restoreHref),
        );
        window.location.hash = nextNavigation.restoreHref;
        return;
      }

      markPendingSettingsScrollRestore(null);
      void navigate({ to: "/" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, pathname]);

  return (
    <SidebarProvider defaultOpen>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
      >
        <ThreadSidebar />
      </Sidebar>
      <DiffWorkerPoolProvider>
        <Outlet />
      </DiffWorkerPoolProvider>
    </SidebarProvider>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
