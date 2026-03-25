import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { SidebarToggleButton } from "../components/SidebarToggleButton";
import { isElectron } from "../env";
import { shortcutLabelForCommand } from "../keybindings";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { cn } from "../lib/utils";
import { useSidebar } from "../components/ui/sidebar";

function ChatIndexRouteView() {
  const { open: sidebarOpen } = useSidebar();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const sidebarToggleShortcutLabel = shortcutLabelForCommand(
    serverConfigQuery.data?.keybindings ?? [],
    "sidebar.toggle",
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
      {!isElectron && (
        <header className="border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <SidebarToggleButton
              className="size-7 shrink-0"
              shortcutLabel={sidebarToggleShortcutLabel}
            />
            <span className="text-sm font-medium text-foreground">Threads</span>
          </div>
        </header>
      )}

      {isElectron && (
        <div
          className={cn(
            "drag-region flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-5",
            !sidebarOpen && "pl-[90px]",
          )}
        >
          <SidebarToggleButton
            className="size-7 shrink-0 no-drag"
            shortcutLabel={sidebarToggleShortcutLabel}
          />
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
