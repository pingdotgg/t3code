import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useAppSettings } from "../appSettings";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import HorizontalTabBar from "../components/HorizontalTabBar";
import ThreadSidebar from "../components/Sidebar";
import { Sidebar, SidebarProvider } from "~/components/ui/sidebar";

function ChatRouteLayout() {
  const navigate = useNavigate();
  const { settings } = useAppSettings();

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  if (settings.horizontalTabs) {
    return (
      <SidebarProvider defaultOpen={false}>
        <div className="flex h-dvh w-full flex-col">
          <HorizontalTabBar />
          <div className="flex min-h-0 flex-1">
            <DiffWorkerPoolProvider>
              <Outlet />
            </DiffWorkerPoolProvider>
          </div>
        </div>
      </SidebarProvider>
    );
  }

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
