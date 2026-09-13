import {
  createEnvironmentTaskAtoms,
  createTaskEnvironmentAtoms,
} from "@t3tools/client-runtime/state/tasks";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import type { ScopedTaskRef } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

export const taskEnvironment = createTaskEnvironmentAtoms(connectionAtomRuntime);
export const environmentTasks = createEnvironmentTaskAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

const emptyTaskAtom = Atom.make<EnvironmentTask | null>(null);

export function useTask(ref: ScopedTaskRef | null) {
  return useAtomValue(ref === null ? emptyTaskAtom : environmentTasks.taskAtom(ref));
}

export function useTasks() {
  return useAtomValue(environmentTasks.tasksAtom);
}
