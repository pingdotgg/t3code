import { type ThreadId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { isElectron } from "../env";
import { useStore } from "../store";
import { GLOBAL_TERMINAL_THREAD_ID } from "../terminalStateStore";
import ScopedTerminalDrawer from "../components/ScopedTerminalDrawer";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";

function ChatIndexRouteView() {
  const projects = useStore((store) => store.projects);
  const lastExpandedProjectId = useStore((store) => store.lastExpandedProjectId);
  const activeProject = useMemo(
    () =>
      (lastExpandedProjectId !== null
        ? projects.find((p) => p.id === lastExpandedProjectId)
        : null) ??
      projects.find((p) => p.expanded) ??
      null,
    [projects, lastExpandedProjectId],
  );
  const projectTerminalThreadId = useMemo(
    () =>
      activeProject !== null
        ? (`project:${String(activeProject.id)}` as ThreadId)
        : null,
    [activeProject],
  );

  const serverConfig = useQuery(serverConfigQueryOptions());
  const globalTerminalCwd =
    serverConfig.data?.homedir ?? serverConfig.data?.cwd ?? "";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col text-muted-foreground/40">
        {!isElectron && (
          <header className="border-b border-border px-3 py-2 md:hidden">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0" />
              <span className="text-sm font-medium text-foreground">
                Threads
              </span>
            </div>
          </header>
        )}

        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs text-muted-foreground/50">
              No active thread
            </span>
          </div>
        )}

        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm">
              Select a thread or create a new one to get started.
            </p>
          </div>
        </div>
      </div>

      {projectTerminalThreadId && activeProject && (
        <ScopedTerminalDrawer
          key={`project-terminal-${String(activeProject.id)}`}
          threadId={projectTerminalThreadId}
          cwd={activeProject.cwd}
          label="Project"
        />
      )}
      {globalTerminalCwd && (
        <ScopedTerminalDrawer
          threadId={GLOBAL_TERMINAL_THREAD_ID}
          cwd={globalTerminalCwd}
          label="Global"
        />
      )}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
