import { CalendarClockIcon } from "lucide-react";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { ScheduledTasksSettingsPanel } from "../components/settings/ScheduledTasksSettings";
import { SidebarInset } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

function ScheduledTasksRouteView() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header
          className={cn(
            "flex h-[52px] shrink-0 items-center border-b border-border px-5 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none",
            isElectron
              ? "drag-region wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]"
              : "sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex min-h-7 items-center gap-2 sm:min-h-6">
            <CalendarClockIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">Scheduled Tasks</span>
          </div>
        </header>
        <ScheduledTasksSettingsPanel />
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/scheduled-tasks")({
  beforeLoad: async ({ context }) => {
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ScheduledTasksRouteView,
});
