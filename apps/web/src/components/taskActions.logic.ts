import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import type { ContextMenuItem, ScopedThreadRef, TaskId } from "@t3tools/contracts";

export function taskMembershipDestinations(
  tasks: readonly EnvironmentTask[],
  thread: ScopedThreadRef & { taskId?: TaskId | null | undefined },
) {
  return tasks.filter(
    (task) =>
      task.environmentId === thread.environmentId &&
      task.archivedAt === null &&
      task.id !== thread.taskId,
  );
}

export type TaskMembershipAction = "move-to-task" | `move-task:${string}` | "remove-from-task";
export function buildTaskMembershipMenuItems(
  tasks: readonly EnvironmentTask[],
  thread: ScopedThreadRef & { taskId?: TaskId | null | undefined },
  projectTitle: (task: EnvironmentTask) => string = () => "",
): ContextMenuItem<TaskMembershipAction>[] {
  const destinations = taskMembershipDestinations(tasks, thread);
  return [
    {
      id: "move-to-task",
      label: "Move to task",
      separatorBefore: true,
      disabled: destinations.length === 0,
      children: destinations.map((task) => ({
        id: `move-task:${task.id}`,
        label: [task.name, projectTitle(task)].filter(Boolean).join(" · "),
      })),
    },
    ...(thread.taskId ? [{ id: "remove-from-task" as const, label: "Remove from task" }] : []),
  ];
}
