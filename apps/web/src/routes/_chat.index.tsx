import { createFileRoute } from "@tanstack/react-router";

import { isElectron, isWindowsElectron } from "../env";
import { DesktopTitleBar } from "../components/DesktopTitleBar";
import { SidebarTrigger } from "../components/ui/sidebar";

function ChatIndexRouteView() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
      {!isElectron && (
        <header className="border-b border-border px-3 py-2 md:hidden">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0" />
            <span className="text-sm font-medium text-foreground">Threads</span>
          </div>
        </header>
      )}

      {isElectron && (
        <DesktopTitleBar
          title="No active thread"
          contextLabel="Workspace"
          contextValue="Threads"
          showContextChip={false}
          titleAlignment="left"
          tone={isWindowsElectron ? "default" : "subtle"}
        />
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
