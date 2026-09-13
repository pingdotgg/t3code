import { EnvironmentId, TaskId, ThreadId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { useProject, useThreadShell } from "./entities";
import { useTask } from "./tasks";
import { resolveMobileWorkbench } from "./task-workbench";

/** Resolves tools from shells only, including empty tasks with no thread detail to load. */
export function useTaskWorkbench(params: {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly taskId?: string;
  readonly threadDetailWorktreePath?: string | null;
}) {
  const environmentId = params.environmentId ? EnvironmentId.make(params.environmentId) : null;
  const threadRef = useMemo(
    () =>
      environmentId !== null && params.threadId
        ? { environmentId, threadId: ThreadId.make(params.threadId) }
        : null,
    [environmentId, params.threadId],
  );
  const thread = useThreadShell(threadRef);
  const taskId = threadRef !== null ? thread?.taskId : params.taskId;
  const taskRef = useMemo(
    () =>
      environmentId !== null && taskId ? { environmentId, taskId: TaskId.make(taskId) } : null,
    [environmentId, taskId],
  );
  const task = useTask(taskRef);
  const projectId = taskRef !== null ? task?.primaryProjectId : thread?.projectId;
  const projectRef = useMemo(
    () => (environmentId !== null && projectId ? { environmentId, projectId } : null),
    [environmentId, projectId],
  );
  const project = useProject(projectRef);
  const isLoading = taskRef !== null && (task === null || project === null);
  const [previous, setPrevious] = useState<{
    taskRef: NonNullable<typeof taskRef>;
    workbench: ReturnType<typeof resolveMobileWorkbench>;
    project: typeof project;
    task: typeof task;
  } | null>(null);
  const resolved = useMemo(
    () =>
      resolveMobileWorkbench({
        threadRef,
        taskRef,
        thread,
        task,
        project,
        previous,
        threadDetailWorktreePath: params.threadDetailWorktreePath,
      }),
    [threadRef, taskRef, thread, task, project, previous, params.threadDetailWorktreePath],
  );
  if (taskRef === null && previous !== null) {
    setPrevious(null);
  } else if (
    !isLoading &&
    taskRef !== null &&
    (previous?.task !== task || previous?.project !== project)
  ) {
    setPrevious({ taskRef, workbench: resolved, task, project });
  }
  const retaining = isLoading && resolved.ownerRef !== null;
  return {
    ...resolved,
    project: retaining ? (previous?.project ?? null) : project,
    task: retaining ? (previous?.task ?? null) : task,
    threadRef,
    taskRef,
    isLoading,
  };
}
