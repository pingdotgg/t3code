import { useMemo } from "react";
import type { ScopedTaskRef, ScopedThreadRef, TaskId } from "@t3tools/contracts";
import { scopeTaskRef } from "@t3tools/client-runtime/environment";
import { taskWorkbenchRef, workbenchRefFor } from "@t3tools/client-runtime/state/task-workbench";
import { readThreadShell, useServerConfigs } from "./entities";
import { readEnvironmentSupportsTasks, readTask, useTask } from "./tasks";
import { useComposerDraftStore } from "../composerDraftStore";

/** Source links keep their real conversation ref for content, resolving only the destination panel. */
export function readWorkbenchRef(ref: ScopedThreadRef): ScopedThreadRef {
  const thread = readThreadShell(ref) ?? useComposerDraftStore.getState().getDraftThreadByRef(ref);
  const task =
    thread?.taskId && readEnvironmentSupportsTasks(ref.environmentId)
      ? readTask(scopeTaskRef(ref.environmentId, thread.taskId))
      : null;
  return workbenchRefFor(ref, thread, task);
}

export function useTaskWorkbench(
  threadRef: ScopedThreadRef | null,
  thread: { readonly taskId?: TaskId | null | undefined } | null | undefined,
  page?: ScopedTaskRef | null,
) {
  const memberTaskId = thread?.taskId ?? null;
  const taskRef = useMemo(
    () =>
      page ??
      (threadRef && memberTaskId ? scopeTaskRef(threadRef.environmentId, memberTaskId) : null),
    [page, threadRef, memberTaskId],
  );
  const candidate = useTask(taskRef);
  const configs = useServerConfigs();
  const task =
    taskRef && configs.get(taskRef.environmentId)?.environment.capabilities.tasks === true
      ? candidate
      : null;
  const taskId = task?.id;
  const taskEnvironmentId = task?.environmentId;
  const ref = useMemo(
    () =>
      page && taskId
        ? taskWorkbenchRef(page)
        : threadRef
          ? workbenchRefFor(
              threadRef,
              { taskId: memberTaskId },
              taskId && taskEnvironmentId ? { id: taskId, environmentId: taskEnvironmentId } : null,
            )
          : null,
    [page, taskId, taskEnvironmentId, threadRef, memberTaskId],
  );
  return { ref, task };
}
