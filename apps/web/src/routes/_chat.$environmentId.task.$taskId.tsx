import { useAtomValue } from "@effect/atom-react";
import { scopedTaskKey } from "@t3tools/client-runtime/environment";
import { taskWorkbenchRef } from "@t3tools/client-runtime/state/task-workbench";
import type { ScopedTaskRef } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { TaskPageBody } from "~/components/tasks/TaskPageBody";
import ChatView from "~/components/ChatView";
import { Button } from "~/components/ui/button";
import { SidebarInset } from "~/components/ui/sidebar";
import { taskPageAvailability } from "~/components/tasks/TaskPage.logic";
import { useTaskActions } from "~/hooks/useTaskActions";
import { useArchivedThreadSnapshots } from "~/lib/archivedThreadsState";
import { useProjects, useServerConfigs } from "~/state/entities";
import { environmentShell } from "~/state/shell";
import { useEnvironment } from "~/state/environments";
import { useTask } from "~/state/tasks";
import { resolveTaskRouteRef } from "~/threadRoutes";

function TaskRouteView() {
  const taskRef = Route.useParams({ select: resolveTaskRouteRef });
  return taskRef ? <TaskRoutePage key={scopedTaskKey(taskRef)} taskRef={taskRef} /> : null;
}

function TaskRoutePage({ taskRef }: { taskRef: ScopedTaskRef }) {
  const task = useTask(taskRef);
  const environment = useEnvironment(taskRef.environmentId);
  const projects = useProjects();
  const shell = useAtomValue(environmentShell.stateValueAtom(taskRef.environmentId));
  const config = useServerConfigs().get(taskRef.environmentId);
  const supportsTasks = config ? config.environment.capabilities.tasks === true : undefined;
  const archiveEnvironmentIds = useMemo(
    () => (task || supportsTasks !== true ? [] : [taskRef.environmentId]),
    [supportsTasks, task, taskRef.environmentId],
  );
  const archive = useArchivedThreadSnapshots(archiveEnvironmentIds);
  const archivedTask =
    archive.snapshots
      .find((entry) => entry.environmentId === taskRef.environmentId)
      ?.snapshot.tasks?.find((candidate) => candidate.id === taskRef.taskId) ?? null;
  const primaryProject = projects.find(
    (project) =>
      project.environmentId === taskRef.environmentId && project.id === task?.primaryProjectId,
  );
  const state = taskPageAvailability({
    shellStatus: shell.status,
    disconnected:
      environment?.connection.phase === "offline" || environment?.connection.phase === "error",
    supportsTasks,
    task,
    archivedTask,
    archiveLoading: archive.isLoading,
    archiveError: archive.error,
    hasPrimaryProject: primaryProject != null,
  });
  const actions = useTaskActions();
  const showWorkbench = task && (state === "ready" || state === "cached");
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      {showWorkbench ? (
        <>
          {state === "cached" ? (
            <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
              Showing saved task data. Reconnect to make changes.
            </p>
          ) : null}
          <ChatView
            routeKind="task"
            task={task}
            environmentId={taskRef.environmentId}
            threadId={taskWorkbenchRef(taskRef).threadId}
          />
        </>
      ) : state === "project-missing" ? (
        <>
          <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
            This task’s primary project is unavailable. Choose another project to continue.
          </p>
          <TaskPageBody taskRef={taskRef} />
        </>
      ) : (
        <div className="m-auto flex max-w-lg flex-col items-center gap-3 p-6 text-center text-sm text-muted-foreground">
          <p>
            {state === "archived"
              ? `“${(task ?? archivedTask)?.name ?? "Task"}” is archived.`
              : state === "unsupported"
                ? "This environment does not support tasks."
                : state === "missing"
                  ? "This task no longer exists."
                  : state === "disconnected" || state === "cached"
                    ? "Reconnect to load this task."
                    : state === "archive-error"
                      ? archive.error
                      : "Loading task…"}
          </p>
          {state === "archived" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void actions.unarchiveTask(taskRef).then((result) => {
                  if (result._tag === "Success") archive.refresh();
                });
              }}
            >
              Unarchive task and threads
            </Button>
          ) : null}
          {state === "archive-error" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                archive.refresh();
              }}
            >
              Retry
            </Button>
          ) : null}
        </div>
      )}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/task/$taskId")({
  component: TaskRouteView,
});
