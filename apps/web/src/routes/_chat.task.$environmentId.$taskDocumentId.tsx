import { TaskDocumentId, type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { lazy, Suspense } from "react";

import { Spinner } from "../components/ui/spinner";
import { SidebarInset } from "../components/ui/sidebar";
import { buildThreadRouteParams } from "../threadRoutes";
import { useProjects, useThreadShells } from "../state/entities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useEnvironmentProviders } from "../state/environments";

const TaskDocumentPane = lazy(() => import("../components/tasks/TaskDocumentPane"));
const isTaskDocumentId = Schema.is(TaskDocumentId);

/** The whole document with no thread: the narrow and maximized view, and a task's home before it has threads. */
function TaskRouteView() {
  const params = useParams({ from: "/_chat/task/$environmentId/$taskDocumentId" });
  const environmentId = params.environmentId as EnvironmentId;
  if (!isTaskDocumentId(params.taskDocumentId)) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden">
        <p className="m-auto text-muted-foreground text-sm">This task link is not valid.</p>
      </SidebarInset>
    );
  }
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col">
        <Suspense fallback={<Spinner className="m-auto" />}>
          <TaskDocumentPane
            key={`${environmentId}:${params.taskDocumentId}`}
            environmentId={environmentId}
            taskDocumentId={params.taskDocumentId}
          />
        </Suspense>
        <TaskThreadLinks environmentId={environmentId} taskDocumentId={params.taskDocumentId} />
      </div>
    </SidebarInset>
  );
}

// Its own component: every thread shell change re-renders this, which must not reach the editor.
function TaskThreadLinks(props: {
  readonly environmentId: EnvironmentId;
  readonly taskDocumentId: TaskDocumentId;
}) {
  const { environmentId } = props;
  const projects = useProjects();
  const providersByEnvironment = useEnvironmentProviders();
  const threads = useThreadShells().filter(
    (thread) =>
      thread.environmentId === environmentId && thread.taskDocumentId === props.taskDocumentId,
  );
  if (threads.length === 0) return null;
  return (
    <nav
      aria-label="Threads in this task"
      className="max-h-1/3 shrink-0 overflow-auto border-t border-border p-2"
    >
      <ul className="flex flex-col gap-px">
        {threads.map((thread) => {
          const project = projects.find(
            (candidate) =>
              candidate.environmentId === environmentId && candidate.id === thread.projectId,
          );
          const providerId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
          const provider = providersByEnvironment
            .get(environmentId)
            ?.find((candidate) => candidate.instanceId === providerId);
          const providerLabel =
            thread.runtime?.providerName ??
            provider?.displayName ??
            provider?.driver ??
            thread.modelSelection.model;
          return (
            <li key={thread.id}>
              <Link
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams(scopeThreadRef(environmentId, thread.id))}
                className="flex min-h-11 items-center rounded-md px-2 py-1 text-sm hover:bg-accent"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{thread.title}</span>
                  <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
                    <span className="min-w-0 truncate">
                      {project?.title ?? "Project unavailable"}
                    </span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5">{providerLabel}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5">
                      {thread.runtime?.status ?? "idle"}
                    </span>
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export const Route = createFileRoute("/_chat/task/$environmentId/$taskDocumentId")({
  component: TaskRouteView,
});
