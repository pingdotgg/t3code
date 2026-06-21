import { useCallback, useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import ThreadSidebar from "./Sidebar";
import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";
import { isElectron } from "~/env";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;
export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const isDesktopHost = isElectron;
  const savedThreadSidebarOpen = useClientSettings(
    (settings) => settings.threadSidebarOpen ?? true,
  );
  const threadSidebarOpen = isDesktopHost ? true : savedThreadSidebarOpen;
  const updateSettings = useUpdateClientSettings();
  const handleThreadSidebarOpenChange = useCallback(
    (open: boolean) => {
      if (isDesktopHost) {
        return;
      }
      updateSettings({ threadSidebarOpen: open });
    },
    [isDesktopHost, updateSettings],
  );

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        void navigate({ to: "/settings" });
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  return (
    <SidebarProvider
      className="h-dvh! min-h-0!"
      forceDesktopLayout={isDesktopHost}
      open={threadSidebarOpen}
      onOpenChange={handleThreadSidebarOpenChange}
    >
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
        resizable={{
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <ThreadSidebar />
        <SidebarRail />
      </Sidebar>
      {children}
    </SidebarProvider>
  );
}
