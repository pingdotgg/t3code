import type { EnvironmentTask, UpdateTaskMetadataInput } from "@t3tools/client-runtime/state/tasks";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useRef } from "react";
import { Alert } from "react-native";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { taskEnvironment } from "../../state/tasks";
import { environmentTasks } from "../../state/tasks";
import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import { useAtomCommand } from "../../state/use-atom-command";
import { refreshArchivedThreadsForEnvironment } from "../archive/useArchivedThreadSnapshots";

type TaskAction = "settle" | "unsettle" | "unsnooze" | "pin" | "unpin" | "archive" | "unarchive";

export function useTaskActions() {
  const settle = useAtomCommand(taskEnvironment.settle, { reportFailure: false });
  const unsettle = useAtomCommand(taskEnvironment.unsettle, { reportFailure: false });
  const unsnooze = useAtomCommand(taskEnvironment.unsnooze, { reportFailure: false });
  const pin = useAtomCommand(taskEnvironment.pin, { reportFailure: false });
  const unpin = useAtomCommand(taskEnvironment.unpin, { reportFailure: false });
  const archive = useAtomCommand(taskEnvironment.archive, { reportFailure: false });
  const unarchive = useAtomCommand(taskEnvironment.unarchive, { reportFailure: false });
  const remove = useAtomCommand(taskEnvironment.delete, { reportFailure: false });
  const snoozeMutation = useAtomCommand(taskEnvironment.snooze, { reportFailure: false });
  const updateMutation = useAtomCommand(taskEnvironment.updateMetadata, { reportFailure: false });
  const busy = useRef(new Set<string>());

  async function run(
    task: EnvironmentTask,
    mutation: () => Promise<AtomCommandResult<unknown, unknown>>,
    queue = false,
  ) {
    const key = `${task.environmentId}:${task.id}`;
    if (!queue && busy.current.has(key)) return false;
    if (
      appAtomRegistry.get(environmentServerConfigsAtom).get(task.environmentId)?.environment
        .capabilities.tasks !== true
    ) {
      Alert.alert("Tasks unavailable", "Update this environment's server to use Tasks.");
      return false;
    }
    if (!queue) busy.current.add(key);
    try {
      const result = await mutation();
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        let message = error instanceof Error ? error.message : String(error);
        for (const member of appAtomRegistry.get(environmentThreadShells.threadShellsAtom)) {
          if (member.environmentId === task.environmentId && member.taskId === task.id) {
            message = message.replaceAll(String(member.id), member.title);
          }
        }
        Alert.alert("Could not update task", message);
        return false;
      }
      return true;
    } finally {
      if (!queue) busy.current.delete(key);
    }
  }

  async function execute(action: TaskAction, task: EnvironmentTask) {
    const command = { environmentId: task.environmentId, input: { taskId: task.id } };
    const success = await run(task, () => {
      if (action === "unsettle")
        return unsettle({ ...command, input: { ...command.input, reason: "user" } });
      if (action === "unsnooze")
        return unsnooze({ ...command, input: { ...command.input, reason: "user" } });
      if (action === "pin") {
        const keys = [
          ...appAtomRegistry.get(environmentTasks.tasksAtom),
          ...appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
        ]
          .flatMap((row) => (row.pinnedAt && row.pinOrderKey ? [row.pinOrderKey] : []))
          .sort();
        const orderKey = pinOrderKeyBetween(null, keys[0] ?? null);
        return pin({ ...command, input: { ...command.input, ...(orderKey ? { orderKey } : {}) } });
      }
      return { settle, pin, unpin, archive, unarchive }[action](command);
    });
    if (success && (action === "archive" || action === "unarchive"))
      refreshArchivedThreadsForEnvironment(task.environmentId);
    return success;
  }

  function confirmDelete(task: EnvironmentTask) {
    const deleteWith = async (threads: "keep" | "delete") => {
      if (
        await run(task, () =>
          remove({ environmentId: task.environmentId, input: { taskId: task.id, threads } }),
        )
      ) {
        refreshArchivedThreadsForEnvironment(task.environmentId);
      }
    };
    Alert.alert(
      "Delete task?",
      `Delete “${task.name}”. Keeping threads preserves their conversations and archive state.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete task, keep threads",
          onPress: () => {
            void deleteWith("keep");
          },
        },
        {
          text: "Delete task and threads",
          style: "destructive",
          onPress: () => {
            Alert.alert(
              "Permanently delete all members?",
              "All member conversations, including archived threads, will be deleted.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Delete all",
                  style: "destructive",
                  onPress: () => {
                    void deleteWith("delete");
                  },
                },
              ],
            );
          },
        },
      ],
    );
  }
  return {
    execute,
    confirmDelete,
    snooze: (task: EnvironmentTask, snoozedUntil: string) =>
      run(task, () =>
        snoozeMutation({
          environmentId: task.environmentId,
          input: { taskId: task.id, snoozedUntil },
        }),
      ),
    update: (task: EnvironmentTask, metadata: Omit<UpdateTaskMetadataInput, "taskId">) =>
      // The command atom serializes sparse edits; a second field blur must not lose its save.
      run(
        task,
        () =>
          updateMutation({
            environmentId: task.environmentId,
            input: { taskId: task.id, ...metadata },
          }),
        true,
      ),
  };
}
