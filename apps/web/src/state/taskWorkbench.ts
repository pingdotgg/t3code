import { isTaskWorkbenchId } from "@t3tools/shared/taskWorkbench";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { TaskId, type ScopedTaskRef, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeTaskRef } from "@t3tools/client-runtime/environment";
import {
  resolveWorkbench,
  resolveWorkbenchOwner,
  canLaunchWorkbench,
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

function readWorkbenchInput(ref: ScopedThreadRef, page?: ScopedTaskRef | null) {
  const thread = page
    ? null
    : (readThreadShell(ref) ?? useComposerDraftStore.getState().getDraftThreadByRef(ref));
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(ref.environmentId);
  const tasksSupported = config ? config.environment.capabilities.tasks === true : undefined;
  const taskRef =
    page ??
    (thread?.taskId && tasksSupported !== false
      ? scopeTaskRef(ref.environmentId, thread.taskId)
      : null);
  return {
    threadRef: page ? null : ref,
    thread: page ? null : thread,
    taskRef,
    tasksSupported,
    authoritative:
      appAtomRegistry.get(environmentShell.stateValueAtom(ref.environmentId)).status === "live",
    task: taskRef ? readTask(taskRef) : null,
  };
}

export function readWorkbench(ref: ScopedThreadRef, page?: ScopedTaskRef | null) {
  return resolveWorkbench({ ...readWorkbenchInput(ref, page), projects: readProjects() });
}

export function readWorkbenchOwner(ref: ScopedThreadRef) {
  return resolveWorkbenchOwner(readWorkbenchInput(ref));
}

/** Click entry points report unavailable identity instead of dropping the action. */
export function readWorkbenchRef(ref: ScopedThreadRef): ScopedThreadRef | null {
  const resolved = readWorkbenchOwner(ref);
  if (resolved.status === "ready") return resolved.ownerRef;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Workbench unavailable",
      description:
        resolved.reason === "loading"
          ? "The workbench is still loading."
          : "The workbench is no longer available.",
    }),
  );
  return null;
}

/** Explicit task resource refs must never be loaded as conversation shells. */
export function canLaunchWorkbenchOwner(ownerRef: ScopedThreadRef) {
  const page = isTaskWorkbenchId(ownerRef.threadId)
    ? { environmentId: ownerRef.environmentId, taskId: TaskId.make(ownerRef.threadId.slice(5)) }
    : null;
  const resolution = readWorkbench(ownerRef, page);
  return (
    canLaunchWorkbench(resolution) &&
    resolution.ownerRef.environmentId === ownerRef.environmentId &&
    resolution.ownerRef.threadId === ownerRef.threadId
  );
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
  // Launch permission is separate from retained display metadata.
  const ref = useMemo(
    () => (taskRef ? taskWorkbenchRef(taskRef) : threadRef),
    [taskRef, threadRef],
  );
  return { ref, task: tasksSupported !== false ? candidate : null, resolution, project };
}
