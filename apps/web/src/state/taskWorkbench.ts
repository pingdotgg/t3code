import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { ScopedTaskRef, ScopedThreadRef } from "@t3tools/contracts";
import { scopeTaskRef } from "@t3tools/client-runtime/environment";
import {
  resolveWorkbench,
  taskWorkbenchRef,
  type WorkbenchInput,
} from "@t3tools/client-runtime/state/task-workbench";
import { readThreadShell, readProjects, useProjects, useServerConfigs } from "./entities";
import { readTask, useTask } from "./tasks";
import { useComposerDraftStore } from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentShell } from "./shell";
import { environmentServerConfigsAtom } from "./server";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
const emptyShellAtom = Atom.make<EnvironmentShellState | null>(null);

export function readWorkbench(ref: ScopedThreadRef, page?: ScopedTaskRef | null) {
  const thread = readThreadShell(ref) ?? useComposerDraftStore.getState().getDraftThreadByRef(ref);
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(ref.environmentId);
  const tasksSupported = config ? config.environment.capabilities.tasks === true : undefined;
  const taskRef =
    page ??
    (thread?.taskId && tasksSupported !== false
      ? scopeTaskRef(ref.environmentId, thread.taskId)
      : null);
  return resolveWorkbench({
    threadRef: page ? null : ref,
    thread: page ? null : thread,
    taskRef,
    tasksSupported,
    authoritative:
      appAtomRegistry.get(environmentShell.stateValueAtom(ref.environmentId)).status === "live",
    task: taskRef ? readTask(taskRef) : null,
    projects: readProjects(),
  });
}

/** Source links retain conversation identity; incomplete workbenches cannot accept destinations. */
export function readWorkbenchRef(ref: ScopedThreadRef): ScopedThreadRef | null {
  const resolved = readWorkbench(ref);
  return resolved.status === "ready" ? resolved.ownerRef : null;
}

export function useTaskWorkbench(
  threadRef: ScopedThreadRef | null,
  thread: WorkbenchInput["thread"],
  page?: ScopedTaskRef | null,
  threadDetailWorktreePath?: string | null,
) {
  const configs = useServerConfigs();
  const environmentId = page?.environmentId ?? threadRef?.environmentId;
  const config = environmentId ? configs.get(environmentId) : null;
  const tasksSupported = config ? config.environment.capabilities.tasks === true : undefined;
  const memberTaskId = thread?.taskId ?? null;
  const taskRef = useMemo(
    () =>
      page ??
      (tasksSupported !== false && threadRef && memberTaskId
        ? scopeTaskRef(threadRef.environmentId, memberTaskId)
        : null),
    [page, tasksSupported, threadRef, memberTaskId],
  );
  const candidate = useTask(taskRef);
  const projects = useProjects();
  // A missing entity in a live snapshot is an authoritative removal.
  const shell = useAtomValue(
    environmentId ? environmentShell.stateValueAtom(environmentId) : emptyShellAtom,
  );
  const resolution = useMemo(
    () =>
      resolveWorkbench({
        threadRef: page ? null : threadRef,
        thread: page ? null : thread,
        taskRef,
        tasksSupported,
        authoritative: shell?.status === "live",
        task: candidate,
        projects,
        threadDetailWorktreePath,
      }),
    [
      page,
      threadRef,
      thread,
      taskRef,
      tasksSupported,
      shell?.status,
      candidate,
      projects,
      threadDetailWorktreePath,
    ],
  );
  const project =
    resolution.status === "ready"
      ? (projects.find(
          (candidate) =>
            candidate.environmentId === resolution.projectRef.environmentId &&
            candidate.id === resolution.projectRef.projectId,
        ) ?? null)
      : null;
  // Keep the intended task's mounted resource namespace while its shell is loading.
  // Only the ready resolution authorizes new tools.
  const ref = useMemo(
    () => (taskRef ? taskWorkbenchRef(taskRef) : threadRef),
    [taskRef, threadRef],
  );
  return { ref, task: tasksSupported ? candidate : null, resolution, project };
}
