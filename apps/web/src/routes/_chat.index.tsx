import { createFileRoute } from "@tanstack/react-router";

import { isElectron } from "../env";
import { useDesktopWindowTitlebarState } from "../hooks/useDesktopWindowTitlebarState";
import { SidebarTrigger, useSidebar } from "../components/ui/sidebar";

function ChatIndexRouteView() {
  const { isMobile, open } = useSidebar();
  const showSidebarTrigger = isMobile || !open;
  const { trafficLightsVisible } = useDesktopWindowTitlebarState();

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
      {!isElectron && (
        <header className="border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            {showSidebarTrigger ? <SidebarTrigger className="size-7 shrink-0" /> : null}
            <span className="text-sm font-medium text-foreground">Threads</span>
          </div>
        </header>
      )}

      {isElectron && (
        <div
          className={`drag-region flex h-[52px] shrink-0 items-center border-b border-border${showSidebarTrigger && trafficLightsVisible ? " pl-[90px] pr-5" : " px-5"}`}
        >
          {showSidebarTrigger ? <SidebarTrigger className="mr-2 shrink-0" /> : null}
          <span className="text-xs text-muted-foreground/50">No active thread</span>
        </div>
      )}

      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <p className="text-sm">Select a thread or create a new one to get started.</p>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
