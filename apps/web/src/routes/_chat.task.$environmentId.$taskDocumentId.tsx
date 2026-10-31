import { TaskDocumentId, type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { lazy, Suspense } from "react";

import { Spinner } from "../components/ui/spinner";
import { SidebarInset } from "../components/ui/sidebar";
import { buildThreadRouteParams } from "../threadRoutes";
import { useThreadShells } from "../state/entities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

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
        {threads.map((thread) => (
          <li key={thread.id}>
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(scopeThreadRef(environmentId, thread.id))}
              className="flex h-7 items-center rounded-md px-2 text-sm hover:bg-accent"
            >
              <span className="truncate">{thread.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export const Route = createFileRoute("/_chat/task/$environmentId/$taskDocumentId")({
  component: TaskRouteView,
});
