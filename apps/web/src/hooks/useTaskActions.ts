import { pinOrderKeyBetween } from "../components/Sidebar.logic";
import {
  type AtomCommand,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { toastManager } from "../components/ui/toast";
import { readThreadShells } from "../state/entities";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ProjectId, ScopedTaskRef, ScopedThreadRef, TaskId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { taskEnvironment, readTask, readTasks } from "../state/tasks";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { buildTaskRouteParams } from "../threadRoutes";

function useTaskCommand<W extends { environmentId: ScopedTaskRef["environmentId"] }, A, E>(
  command: AtomCommand<W, A, E>,
  title: string,
) {
  const run = useAtomCommand(command, { reportFailure: false });
  return useCallback(
    async (input: W) => {
      const result = await run(input);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        let description = error instanceof Error ? error.message : "An error occurred.";
        for (const member of readThreadShells()) {
          if (member.environmentId === input.environmentId)
            description = description.replace(`member '${member.id}'`, `member “${member.title}”`);
        }
        toastManager.add({ type: "error", title, description });
      }
      return result;
    },
    [run, title],
  );
}

function taskPinOrderKey() {
  const keys = [...readTasks(), ...readThreadShells()].flatMap((entity) =>
    entity.pinnedAt && entity.pinOrderKey ? [entity.pinOrderKey] : [],
  );
  return pinOrderKeyBetween(null, keys.toSorted()[0] ?? null) ?? undefined;
}

/** Shared actions for task pages, rows and the palette; success stays quiet. */
export function useTaskActions() {
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  const createTask = useTaskCommand(taskEnvironment.create, "Could not create task");
  const update = useTaskCommand(taskEnvironment.updateMetadata, "Could not update task");
  const settle = useTaskCommand(taskEnvironment.settle, "Could not settle task");
  const unsettle = useTaskCommand(taskEnvironment.unsettle, "Could not un-settle task");
  const snooze = useTaskCommand(taskEnvironment.snooze, "Could not snooze task");
  const unsnooze = useTaskCommand(taskEnvironment.unsnooze, "Could not wake task");
  const pin = useTaskCommand(taskEnvironment.pin, "Could not pin task");
  const unpin = useTaskCommand(taskEnvironment.unpin, "Could not unpin task");
  const reorderPin = useTaskCommand(taskEnvironment.reorderPin, "Could not reorder task");
  const reorderActive = useTaskCommand(taskEnvironment.reorderActive, "Could not reorder task");
  const archive = useTaskCommand(taskEnvironment.archive, "Could not archive task");
  const unarchive = useTaskCommand(taskEnvironment.unarchive, "Could not restore task");
  const remove = useTaskCommand(taskEnvironment.delete, "Could not delete task");
  const setTask = useTaskCommand(threadEnvironment.setTask, "Could not change task membership");
  const openTask = useCallback(
    (ref: ScopedTaskRef) =>
      router.navigate({
        to: "/$environmentId/task/$taskId",
        params: buildTaskRouteParams(ref),
      }),
    [router],
  );
  const newThreadInTask = useCallback(
    async (ref: ScopedTaskRef) => {
      const task = readTask(ref);
      if (!task || task.archivedAt !== null) return;
      return handleNewThread(scopeProjectRef(ref.environmentId, task.primaryProjectId), {
        taskId: task.id,
      });
    },
    [handleNewThread],
  );
  return useMemo(
    () => ({
      createTask,
      openTask,
      newThreadInTask,
      updateTaskMetadata: (
        ref: ScopedTaskRef,
        input: { name?: string; description?: string | null; primaryProjectId?: ProjectId },
      ) => update({ environmentId: ref.environmentId, input: { taskId: ref.taskId, ...input } }),
      settleTask: (ref: ScopedTaskRef) =>
        settle({ environmentId: ref.environmentId, input: { taskId: ref.taskId } }),
      unsettleTask: (ref: ScopedTaskRef) =>
        unsettle({
          environmentId: ref.environmentId,
          input: { taskId: ref.taskId, reason: "user" },
        }),
      snoozeTask: (ref: ScopedTaskRef, snoozedUntil: string) =>
        snooze({ environmentId: ref.environmentId, input: { taskId: ref.taskId, snoozedUntil } }),
      unsnoozeTask: (ref: ScopedTaskRef) =>
        unsnooze({
          environmentId: ref.environmentId,
          input: { taskId: ref.taskId, reason: "user" },
        }),
      pinTask: (ref: ScopedTaskRef, orderKey?: string) => {
        const key = orderKey ?? taskPinOrderKey();
        return pin({
          environmentId: ref.environmentId,
          input: { taskId: ref.taskId, ...(key ? { orderKey: key } : {}) },
        });
      },
      unpinTask: (ref: ScopedTaskRef) =>
        unpin({ environmentId: ref.environmentId, input: { taskId: ref.taskId } }),
      reorderPinnedTask: (ref: ScopedTaskRef, orderKey: string) =>
        reorderPin({ environmentId: ref.environmentId, input: { taskId: ref.taskId, orderKey } }),
      reorderActiveTask: (ref: ScopedTaskRef, orderKey: string) =>
        reorderActive({
          environmentId: ref.environmentId,
          input: { taskId: ref.taskId, orderKey },
        }),
      archiveTask: async (ref: ScopedTaskRef) => {
        const result = await archive({
          environmentId: ref.environmentId,
          input: { taskId: ref.taskId },
        });
        if (result._tag === "Success") refreshArchivedThreadsForEnvironment(ref.environmentId);
        return result;
      },
      unarchiveTask: async (ref: ScopedTaskRef) => {
        const result = await unarchive({
          environmentId: ref.environmentId,
          input: { taskId: ref.taskId },
        });
        if (result._tag === "Success") refreshArchivedThreadsForEnvironment(ref.environmentId);
        return result;
      },
      deleteTask: async (ref: ScopedTaskRef, threads: "keep" | "delete") => {
        const result = await remove({
          environmentId: ref.environmentId,
          input: { taskId: ref.taskId, threads },
        });
        if (result._tag === "Success") refreshArchivedThreadsForEnvironment(ref.environmentId);
        return result;
      },
      moveThreadToTask: (ref: ScopedThreadRef, taskId: TaskId | null) =>
        setTask({ environmentId: ref.environmentId, input: { threadId: ref.threadId, taskId } }),
    }),
    [
      archive,
      createTask,
      newThreadInTask,
      openTask,
      pin,
      remove,
      reorderActive,
      reorderPin,
      setTask,
      settle,
      snooze,
      unarchive,
      unpin,
      unsettle,
      unsnooze,
      update,
    ],
  );
}
