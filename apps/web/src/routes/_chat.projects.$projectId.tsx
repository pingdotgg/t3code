import { ProjectId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { Button } from "../components/ui/button";
import { SidebarTrigger } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSettings } from "../hooks/useSettings";
import { resolveProjectRouteTarget } from "../projectRoute";
import { useStore } from "../store";

function ProjectRouteView() {
  const navigate = useNavigate();
  const projectId = Route.useParams({
    select: (params) => ProjectId.makeUnsafe(params.projectId),
  });
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const appSettings = useSettings();
  const { handleNewThread } = useHandleNewThread();
  const target = useMemo(
    () =>
      resolveProjectRouteTarget({
        projectId,
        projects,
        threads,
        threadSortOrder: appSettings.sidebarThreadSortOrder,
      }),
    [appSettings.sidebarThreadSortOrder, projectId, projects, threads],
  );

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    if (target.kind === "missing") {
      void navigate({ to: "/", replace: true });
      return;
    }

    setProjectExpanded(projectId, true);

    if (target.kind === "thread") {
      void navigate({
        to: "/projects/$projectId/threads/$threadId",
        params: { projectId, threadId: target.threadId },
        replace: true,
      });
    }
  }, [navigate, projectId, setProjectExpanded, target, threadsHydrated]);

  if (!threadsHydrated || target.kind !== "empty") {
    return null;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
      {!isElectron && (
        <header className="border-b border-border px-3 py-2 md:hidden">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0" />
            <span className="text-sm font-medium text-foreground">{target.project.name}</span>
          </div>
        </header>
      )}

      {isElectron && (
        <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
          <span className="truncate text-xs text-muted-foreground/50">{target.project.name}</span>
        </div>
      )}

      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-md text-center">
          <p className="text-sm text-foreground">This project does not have any threads yet.</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Create a thread to start working in {target.project.name}.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-4"
            onClick={() =>
              void handleNewThread(projectId, {
                envMode: appSettings.defaultThreadEnvMode,
              })
            }
          >
            New thread
          </Button>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_chat/projects/$projectId")({
  component: ProjectRouteView,
});
