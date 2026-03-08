import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ThreadId } from "@t3tools/contracts";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import ThreadSidebar from "../components/Sidebar";
import ScopedTerminalDrawer from "../components/ScopedTerminalDrawer";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { Sidebar, SidebarProvider } from "~/components/ui/sidebar";

const GLOBAL_TERMINAL_THREAD_ID = "global" as ThreadId;

function ChatRouteLayout() {
  const navigate = useNavigate();
  const serverConfig = useQuery(serverConfigQueryOptions());
  const serverCwd = serverConfig.data?.cwd ?? "";

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

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <SidebarProvider
        defaultOpen
        className="min-h-0 flex-1 overflow-hidden"
        style={{ minHeight: 0 } as React.CSSProperties}
      >
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
      {serverCwd && (
        <ScopedTerminalDrawer threadId={GLOBAL_TERMINAL_THREAD_ID} cwd={serverCwd} />
      )}
    </div>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
