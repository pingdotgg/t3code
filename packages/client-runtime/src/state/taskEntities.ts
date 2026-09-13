import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationTaskShell,
  ScopedTaskRef,
  TaskId,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { parseScopedTaskKey, scopedTaskKey } from "../environment/scoped.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import { arrayElementsEqual } from "./entities.ts";
import { type EnvironmentTask, scopeTask } from "./models.ts";

const EMPTY_TASKS: ReadonlyArray<OrchestrationTaskShell> = Object.freeze([]);
const EMPTY_INDEX: ReadonlyMap<TaskId, OrchestrationTaskShell> = new Map();

/** Shell-backed task reads never hydrate member conversations. */
export function createEnvironmentTaskAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
}) {
  const scoped = new WeakMap<OrchestrationTaskShell, Map<EnvironmentId, EnvironmentTask>>();
  const scopedTask = (environmentId: EnvironmentId, task: OrchestrationTaskShell) => {
    let values = scoped.get(task);
    if (values === undefined) {
      values = new Map();
      scoped.set(task, values);
    }
    let value = values.get(environmentId);
    if (value === undefined) {
      value = scopeTask(environmentId, task);
      values.set(environmentId, value);
    }
    return value;
  };
  const environmentTasksAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationTaskShell> =>
        get(input.snapshotAtom(environmentId))?.tasks ?? EMPTY_TASKS,
    ).pipe(Atom.withLabel(`environment-tasks:${environmentId}`)),
  );
  const environmentTaskIndexAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyMap<TaskId, OrchestrationTaskShell> => {
      const tasks = get(environmentTasksAtom(environmentId));
      return tasks.length === 0 ? EMPTY_INDEX : new Map(tasks.map((task) => [task.id, task]));
    }).pipe(Atom.withLabel(`environment-task-index:${environmentId}`)),
  );
  const taskAtomFamily = Atom.family((key: string) => {
    const ref = parseScopedTaskKey(key)!;
    return Atom.make((get) => {
      const task = get(environmentTaskIndexAtom(ref.environmentId)).get(ref.taskId);
      return task === undefined ? null : scopedTask(ref.environmentId, task);
    }).pipe(Atom.withLabel(`environment-task:${key}`));
  });
  let previous: ReadonlyArray<EnvironmentTask> = [];
  const tasksAtom = Atom.make((get) => {
    const next = [...enabledEnvironmentIds(get(input.catalogValueAtom))].flatMap((environmentId) =>
      get(environmentTasksAtom(environmentId)).map((task) => scopedTask(environmentId, task)),
    );
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel("environment-task-list"));
  return {
    environmentTasksAtom,
    environmentTaskIndexAtom,
    tasksAtom,
    taskAtom: (ref: ScopedTaskRef) => taskAtomFamily(scopedTaskKey(ref)),
  };
}
