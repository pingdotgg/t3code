import { TaskId, type ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";
import { buildTaskMembershipMenuItems } from "../components/taskActions.logic";
import { readProject, readThreadShell } from "../state/entities";
import { readEnvironmentSupportsTasks, readTasks } from "../state/tasks";
import { useTaskActions } from "./useTaskActions";

export function readTaskMembershipMenuItems(ref: ScopedThreadRef) {
  const thread = readThreadShell(ref);
  if (!thread || !readEnvironmentSupportsTasks(ref.environmentId)) return [];
  return buildTaskMembershipMenuItems(
    readTasks(),
    { ...ref, taskId: thread.taskId },
    (task) =>
      readProject({ environmentId: task.environmentId, projectId: task.primaryProjectId })?.title ??
      "",
  );
}

export function useTaskMembershipActions() {
  const { moveThreadToTask, openTask } = useTaskActions();
  const handleTaskMembershipAction = useCallback(
    async (ref: ScopedThreadRef, action: string | null): Promise<boolean> => {
      if (action === "remove-from-task") {
        await moveThreadToTask(ref, null);
        return true;
      }
      if (action?.startsWith("move-task:")) {
        await moveThreadToTask(ref, TaskId.make(action.slice("move-task:".length)));
        return true;
      }
      if (action === "open-task") {
        const thread = readThreadShell(ref);
        if (thread?.taskId)
          await openTask({ environmentId: ref.environmentId, taskId: thread.taskId });
        return true;
      }
      return false;
    },
    [moveThreadToTask, openTask],
  );
  return useMemo(() => ({ handleTaskMembershipAction }), [handleTaskMembershipAction]);
}
