import {
  ThreadId,
  type EnvironmentId,
  type ScopedTaskRef,
  type ScopedThreadRef,
  type TaskId,
} from "@t3tools/contracts";
import { taskWorkbenchId } from "@t3tools/shared/taskWorkbench";
import { scopeThreadRef } from "../environment/scoped.ts";

/** Resource identity only: never use this ref to load a conversation or start a provider. */
export function taskWorkbenchRef(ref: ScopedTaskRef): ScopedThreadRef {
  return scopeThreadRef(ref.environmentId, ThreadId.make(taskWorkbenchId(ref.taskId)));
}

export function workbenchRefFor(
  ref: ScopedThreadRef,
  thread:
    | { readonly taskId?: TaskId | null | undefined; readonly environmentId?: EnvironmentId }
    | null
    | undefined,
  task: { readonly id: TaskId; readonly environmentId: EnvironmentId } | null | undefined,
): ScopedThreadRef {
  return task &&
    task.environmentId === ref.environmentId &&
    thread?.taskId === task.id &&
    (thread.environmentId === undefined || thread.environmentId === ref.environmentId)
    ? taskWorkbenchRef({ environmentId: ref.environmentId, taskId: task.id })
    : ref;
}
