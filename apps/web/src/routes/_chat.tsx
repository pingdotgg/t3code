import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { type ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import { resolveShortcutCommand } from "../keybindings";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import ThreadSidebar from "../components/Sidebar";
import { Sidebar, SidebarProvider } from "~/components/ui/sidebar";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

function ChatRouteLayout() {
  const navigate = useNavigate();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;

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
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (resolveShortcutCommand(event, keybindings) !== "settings.open") return;
      event.preventDefault();
      event.stopPropagation();
      void navigate({ to: "/settings" });
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [keybindings, navigate]);

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
