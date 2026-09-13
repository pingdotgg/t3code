import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";

type TaskNavigationTarget = Pick<
  EnvironmentTask,
  "environmentId" | "id" | "primaryProjectId" | "archivedAt"
>;
export type TaskNavigationIntent = "open" | "new-thread" | "rename";

/** Keep task destinations and draft scope identical across rows, menus and pages. */
export function resolveTaskNavigation(input: {
  readonly task: TaskNavigationTarget;
  readonly intent: TaskNavigationIntent;
  readonly usesSplitView: boolean;
  readonly currentRouteName: string | undefined;
}) {
  const { task, intent } = input;
  if (task.archivedAt !== null && intent !== "open") return null;
  if (intent === "new-thread")
    return {
      action: "navigate" as const,
      screen: "NewTaskSheet" as const,
      params: {
        screen: "NewTaskDraft" as const,
        params: {
          environmentId: task.environmentId,
          projectId: task.primaryProjectId,
          taskId: task.id,
        },
      },
    };
  const action =
    !input.usesSplitView || input.currentRouteName === "Home"
      ? "push"
      : input.currentRouteName === "Task"
        ? "set-params"
        : "replace";
  return {
    action,
    screen: "Task" as const,
    params: {
      environmentId: task.environmentId,
      taskId: task.id,
      focusName: intent === "rename",
    },
  };
}
