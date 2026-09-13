import { useCallback } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Alert } from "react-native";
import * as Cause from "effect/Cause";
import {
  taskOrderRow,
  threadOrderRow,
  type TaskOrderRow,
} from "@t3tools/client-runtime/state/task-grouping";
import { taskEnvironment, environmentTasks } from "../../state/tasks";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { environmentServerConfigsAtom } from "../../state/server";
import { appAtomRegistry } from "../../state/atom-registry";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import { useAtomCommand } from "../../state/use-atom-command";
import { getPendingThreadOrder, threadDropBusyAtom } from "../../state/thread-order";
import { planMobileTaskMove } from "./taskOrder";
import type { ThreadMoveDestination } from "./threadOrder";

export function readMobileTaskMove(row: TaskOrderRow, destination: ThreadMoveDestination) {
  const tasks = appAtomRegistry.get(environmentTasks.tasksAtom);
  const threads = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
  const current =
    row.kind === "task"
      ? tasks
          .filter((task) => task.id === row.entity.id && task.environmentId === row.environmentId)
          .map(taskOrderRow)[0]
      : threads
          .filter(
            (thread) => thread.id === row.entity.id && thread.environmentId === row.environmentId,
          )
          .map(threadOrderRow)[0];
  if (current == null || current.entity.archivedAt !== null) return null;
  row = current;
  const configs = appAtomRegistry.get(environmentServerConfigsAtom);
  const shelf =
    typeof destination === "object"
      ? destination.section
      : row.entity.pinnedAt != null
        ? "pinned"
        : "active";
  const taskIds = new Set(
    [...configs].flatMap(([id, c]) => (c.environment.capabilities.tasks === true ? [id] : [])),
  );
  return planMobileTaskMove({
    moved: row,
    destination,
    tasks: appAtomRegistry.get(environmentTasks.tasksAtom),
    threads: appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
    capableIds: taskIds,
    writableTaskIds: taskIds,
    writableThreadIds: new Set(
      [...configs].flatMap(([id, c]) =>
        (shelf === "pinned"
          ? c.environment.capabilities.threadPinReorder
          : c.environment.capabilities.threadActiveReorder) === true
          ? [id]
          : [],
      ),
    ),
    now: new Date().toISOString(),
    queued: appAtomRegistry.get(queuedThreadKeysAtom),
  });
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
