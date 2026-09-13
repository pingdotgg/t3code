import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Alert } from "react-native";
import * as Cause from "effect/Cause";
import { type TaskOrderRow } from "@t3tools/client-runtime/state/task-grouping";
import { taskEnvironment, environmentTasks } from "../../state/tasks";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { environmentServerConfigsAtom } from "../../state/server";
import { appAtomRegistry } from "../../state/atom-registry";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import { useAtomCommand } from "../../state/use-atom-command";
import { getPendingThreadOrder, threadDropBusyAtom } from "../../state/thread-order";
import { createMobileTaskMovePlanner, planMobileTaskMove } from "./taskOrder";
import type { ThreadMoveDestination } from "./threadOrder";

export function readMobileTaskMove(row: TaskOrderRow, destination: ThreadMoveDestination) {
  const tasks = appAtomRegistry.get(environmentTasks.tasksAtom);
  const threads = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
  const configs = appAtomRegistry.get(environmentServerConfigsAtom);
  return planMobileTaskMove({
    ...mobileTaskMoveCapabilities(configs),
    moved: row,
    destination,
    tasks,
    threads,
    now: new Date().toISOString(),
    queued: appAtomRegistry.get(queuedThreadKeysAtom),
  });
}

function mobileTaskMoveCapabilities(configs: ReadonlyMap<EnvironmentId, ServerConfig>) {
  const capableIds = new Set(
    [...configs].flatMap(([id, config]) =>
      config.environment.capabilities.tasks === true ? [id] : [],
    ),
  );
  return {
    capableIds,
    writableTaskIds: capableIds,
    writableThreadIds: new Set(
      [...configs].flatMap(([id, config]) =>
        config.environment.capabilities.threadActiveReorder === true ? [id] : [],
      ),
    ),
    writablePinnedThreadIds: new Set(
      [...configs].flatMap(([id, config]) =>
        config.environment.capabilities.threadPinReorder === true ? [id] : [],
      ),
    ),
  };
}

/** Subscribe once at the list owner, never from render-time menu checks. */
export function useMobileTaskMovePlanner(now: string) {
  const tasks = useAtomValue(environmentTasks.tasksAtom);
  const threads = useAtomValue(environmentThreadShells.threadShellsAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const queued = useAtomValue(queuedThreadKeysAtom);
  const capabilities = useMemo(() => mobileTaskMoveCapabilities(configs), [configs]);
  return useMemo(
    () => createMobileTaskMovePlanner({ tasks, threads, queued, now, ...capabilities }),
    [tasks, threads, queued, now, capabilities],
  );
}

/** Writes shared planner assignments using the entity's real dispatch identity. */
export function useMobileTaskOrder() {
  const busy = useAtomValue(threadDropBusyAtom);
  const taskPinOrder = useAtomCommand(taskEnvironment.reorderPin);
  const taskActiveOrder = useAtomCommand(taskEnvironment.reorderActive);
  const threadPinOrder = useAtomCommand(threadEnvironment.reorderPin);
  const threadActiveOrder = useAtomCommand(threadEnvironment.reorderActive);
  const move = useCallback(
    async (row: TaskOrderRow, destination: ThreadMoveDestination) => {
      if (getPendingThreadOrder() !== null || appAtomRegistry.get(threadDropBusyAtom)) return false;
      const plan = readMobileTaskMove(row, destination);
      if (plan === null || plan.crossSection) return false;
      appAtomRegistry.set(threadDropBusyAtom, true);
      try {
        for (const assignment of plan.assignments) {
          const result =
            assignment.kind === "task"
              ? await (plan.shelf === "pinned" ? taskPinOrder : taskActiveOrder)({
                  environmentId: assignment.ref.environmentId,
                  input: { taskId: assignment.ref.taskId, orderKey: assignment.orderKey },
                })
              : await (plan.shelf === "pinned" ? threadPinOrder : threadActiveOrder)({
                  environmentId: assignment.ref.environmentId,
                  input: { threadId: assignment.ref.threadId, orderKey: assignment.orderKey },
                });
          if (result._tag === "Failure") {
            Alert.alert("Could not reorder", String(Cause.squash(result.cause)));
            return false;
          }
        }
        return true;
      } finally {
        appAtomRegistry.set(threadDropBusyAtom, false);
      }
    },
    [taskPinOrder, taskActiveOrder, threadPinOrder, threadActiveOrder],
  );
  return { move, busy };
}
