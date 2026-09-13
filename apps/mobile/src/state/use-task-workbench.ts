import { EnvironmentId, TaskId, ThreadId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { useProject, useThreadShell, useEnvironmentServerConfig } from "./entities";
import { useTask } from "./tasks";
import { resolveMobileWorkbench } from "./task-workbench";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { environmentShell } from "./shell";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
const emptyShellAtom = Atom.make<EnvironmentShellState | null>(null);

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
  const config = useEnvironmentServerConfig(environmentId);
  const tasksSupported = config ? config.environment.capabilities.tasks === true : undefined;
  const shell = useAtomValue(
    environmentId ? environmentShell.stateValueAtom(environmentId) : emptyShellAtom,
  );
  const authoritative = shell?.status === "live";
  const taskId =
    threadRef !== null ? (tasksSupported !== false ? thread?.taskId : null) : params.taskId;
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
        tasksSupported,
        authoritative,
        threadDetailWorktreePath: params.threadDetailWorktreePath,
      }),
    [
      threadRef,
      taskRef,
      thread,
      task,
      project,
      previous,
      tasksSupported,
      authoritative,
      params.threadDetailWorktreePath,
    ],
  );
  const isLoading =
    resolved.resolution.status === "unavailable" && resolved.resolution.reason === "loading";
  if ((taskRef === null || resolved.ownerRef === null) && previous !== null) {
    setPrevious(null);
  } else if (
    resolved.resolution.status === "ready" &&
    taskRef !== null &&
    (previous?.task !== task || previous?.project !== project)
  ) {
    setPrevious({ taskRef, workbench: resolved, task, project });
  }
  return {
    ...resolved,
    project:
      resolved.resolution.status === "ready"
        ? project
        : resolved.ownerRef && resolved.resolution.reason === "loading"
          ? (previous?.project ?? null)
          : null,
    task,
    threadRef,
    taskRef,
    isLoading,
  };
}
