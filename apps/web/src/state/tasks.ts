import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedTaskRef } from "@t3tools/contracts";
import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import { Atom } from "effect/unstable/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "./server";
import {
  createEnvironmentTaskAtoms,
  createTaskEnvironmentAtoms,
} from "@t3tools/client-runtime/state/tasks";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const taskEnvironment = createTaskEnvironmentAtoms(connectionAtomRuntime);
export const environmentTasks = createEnvironmentTaskAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

/** Task state is scoped to its owning environment, just like thread state. */
export function readTask(ref: ScopedTaskRef) {
  return appAtomRegistry.get(environmentTasks.taskAtom(ref));
}
export function readTasks() {
  return appAtomRegistry.get(environmentTasks.tasksAtom);
}
export function useTasks() {
  return useAtomValue(environmentTasks.tasksAtom);
}
export function useTask(ref: ScopedTaskRef | null) {
  return useAtomValue(ref ? environmentTasks.taskAtom(ref) : EMPTY_TASK_ATOM);
}
export function readEnvironmentSupportsTasks(environmentId: EnvironmentId) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .tasks === true
  );
}

/** Wait for the accepted command's shell cursor before opening a newly created task. */
export function waitForTask(ref: ScopedTaskRef, sequence: number, timeoutMs = 10_000) {
  const atom = environmentSnapshotAtom(ref.environmentId);
  return new Promise<NonNullable<ReturnType<typeof readTask>>>((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      reject(new Error("The task has not appeared yet. Retry to open it."));
    }, timeoutMs);
    const check = () => {
      const snapshot = appAtomRegistry.get(atom);
      const task = readTask(ref);
      if (task && snapshot && snapshot.snapshotSequence >= sequence) {
        clearTimeout(timeout);
        unsubscribe?.();
        resolve(task);
      }
    };
    unsubscribe = appAtomRegistry.subscribe(atom, check);
    check();
  });
}

const EMPTY_TASK_ATOM = Atom.make<EnvironmentTask | null>(null);
