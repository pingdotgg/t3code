import { createFileRoute } from "@tanstack/react-router";
import { SidebarInset } from "~/components/ui/sidebar";
import { useTask } from "~/state/tasks";
import { resolveTaskRouteRef } from "~/threadRoutes";

function TaskRouteView() {
  const taskRef = Route.useParams({ select: resolveTaskRouteRef });
  const task = useTask(taskRef);
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden bg-background text-foreground md:h-dvh">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <h1 className="text-xl font-semibold">{task?.name ?? "Task"}</h1>
        {task?.description ? (
          <p className="mt-3 whitespace-pre-wrap text-muted-foreground">{task.description}</p>
        ) : null}
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/task/$taskId")({
  component: TaskRouteView,
});
