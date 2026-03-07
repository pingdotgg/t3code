import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import ThreadSidebar from "../components/Sidebar";
import { useAppSidebarCompact } from "../hooks/useAppSidebarCompact";
import { Sidebar, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 14 * 16;
const THREAD_SIDEBAR_MAX_WIDTH = 28 * 16;

function ChatRouteLayout() {
  const navigate = useNavigate();
  const shouldUseCompactSidebar = useAppSidebarCompact();
  const [sidebarOpen, setSidebarOpen] = useState(() => !shouldUseCompactSidebar);
  const previousCompactSidebarRef = useRef(shouldUseCompactSidebar);

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

  useEffect(() => {
    if (previousCompactSidebarRef.current === shouldUseCompactSidebar) {
      return;
    }

    previousCompactSidebarRef.current = shouldUseCompactSidebar;
    setSidebarOpen(!shouldUseCompactSidebar);
  }, [shouldUseCompactSidebar]);

  return (
    <SidebarProvider defaultOpen open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
        resizable={{
          maxWidth: THREAD_SIDEBAR_MAX_WIDTH,
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <ThreadSidebar />
        <SidebarRail />
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
