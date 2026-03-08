import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import { DESKTOP_CAPTURE_SCREENSHOT_EVENT } from "../desktopEvents";
import ThreadSidebar from "../components/Sidebar";
import { Sidebar, SidebarProvider } from "~/components/ui/sidebar";

function ChatRouteLayout() {
  const navigate = useNavigate();

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        void navigate({ to: "/settings" });
        return;
      }
      if (action === "capture-screenshot") {
        window.dispatchEvent(new CustomEvent(DESKTOP_CAPTURE_SCREENSHOT_EVENT));
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

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
