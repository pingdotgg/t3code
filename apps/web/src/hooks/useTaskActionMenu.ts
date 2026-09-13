import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { ContextMenuItem, ScopedTaskRef } from "@t3tools/contracts";
import { useCallback } from "react";
import { readLocalApi } from "../localApi";
import { readTask, readEnvironmentSupportsTasks } from "../state/tasks";
import { readThreadShells } from "../state/entities";
import { requestAddThreadsToTask, requestDeleteTask, requestRenameTask } from "../taskDialogStore";
import { resolveSnoozePresets } from "../components/Sidebar.snooze";
import { taskSettleBlocker, taskSnoozeBlocker } from "@t3tools/client-runtime/state/task-grouping";
import { useClientSettings } from "./useSettings";
import { useTaskActions } from "./useTaskActions";

export function useTaskActionMenu(
  taskRef: ScopedTaskRef | null,
  options?: { onStartRename?: () => void },
) {
  const actions = useTaskActions();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const openMenu = useCallback(
    (position: { x: number; y: number }) => {
      if (!taskRef || !readEnvironmentSupportsTasks(taskRef.environmentId)) return;
      void (async () => {
        const task = readTask(taskRef);
        const api = readLocalApi();
        if (!task || !api) return;
        const members = readThreadShells().filter(
          (thread) => thread.environmentId === taskRef.environmentId && thread.taskId === task.id,
        );
        const now = new Date();
        const presets = resolveSnoozePresets(now, timestampFormat);
        const snoozed = task.snoozedUntil !== null && Date.parse(task.snoozedUntil) > Date.now();
        const items: ContextMenuItem<string>[] = [
          { id: "open", label: "Open task" },
          {
            id: "add-threads",
            label: "Add threads…",
            disabled: task.archivedAt !== null,
            icon: "plus",
          },
          {
            id: "new-thread",
            label: "New thread in task",
            disabled: task.archivedAt !== null,
            icon: "plus",
          },
          { id: "rename", label: "Rename…", icon: "pencil", separatorBefore: true },
          {
            id: task.pinnedAt ? "unpin" : "pin",
            label: task.pinnedAt ? "Unpin task" : "Pin task",
            disabled: task.archivedAt !== null,
          },
          task.settledOverride === "settled"
            ? { id: "unsettle", label: "Un-settle task", separatorBefore: true }
            : {
                id: "settle",
                label: "Settle task",
                separatorBefore: true,
                disabled: taskSettleBlocker(members, { now: now.toISOString() }) !== null,
              },
          snoozed
            ? { id: "wake", label: "Wake task" }
            : {
                id: "snooze",
                label: "Snooze task",
                disabled: taskSnoozeBlocker(members, { now: now.toISOString() }) !== null,
                children: presets.map((preset) => ({
                  id: `snooze:${preset.id}`,
                  label: `${preset.label} (${preset.whenLabel})`,
                })),
              },
          {
            id: task.archivedAt ? "unarchive" : "archive",
            label: task.archivedAt ? "Unarchive task" : "Archive task",
            icon: "archive",
          },
          { id: "delete", label: "Delete task…", destructive: true, separatorBefore: true },
        ];
        const clicked = await settlePromise(() => api.contextMenu.show(items, position));
        if (clicked._tag === "Failure" || !clicked.value) return;
        const action = clicked.value;
        if (action.startsWith("snooze:")) {
          const preset = presets.find((entry) => `snooze:${entry.id}` === action);
          if (preset) await actions.snoozeTask(taskRef, preset.snoozedUntil);
          return;
        }
        switch (action) {
          case "add-threads":
            requestAddThreadsToTask(taskRef);
            break;
          case "open":
            await actions.openTask(taskRef);
            break;
          case "new-thread":
            await actions.newThreadInTask(taskRef);
            break;
          case "rename":
            if (options?.onStartRename) options.onStartRename();
            else requestRenameTask(taskRef);
            break;
          case "pin":
            await actions.pinTask(taskRef);
            break;
          case "unpin":
            await actions.unpinTask(taskRef);
            break;
          case "settle":
            await actions.settleTask(taskRef);
            break;
          case "unsettle":
            await actions.unsettleTask(taskRef);
            break;
          case "wake":
            await actions.unsnoozeTask(taskRef);
            break;
          case "archive":
            await actions.archiveTask(taskRef);
            break;
          case "unarchive":
            await actions.unarchiveTask(taskRef);
            break;
          case "delete":
            requestDeleteTask(taskRef);
            break;
        }
      })();
    },
    [actions, options, taskRef, timestampFormat],
  );
  const closeMenu = useCallback(() => {
    void readLocalApi()?.contextMenu.close();
  }, []);
  return { openMenu, closeMenu };
}
