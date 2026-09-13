import { useCallback, useMemo } from "react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import { Alert } from "react-native";
import { useTasks } from "../../state/tasks";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";

export function useThreadTaskMenu(thread: EnvironmentThreadShell) {
  const tasks = useTasks();
  const config = useEnvironmentServerConfig(thread.environmentId);
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const setTask = useAtomCommand(threadEnvironment.setTask, { reportFailure: false });
  const supported = config?.environment.capabilities.tasks === true;
  const available = useMemo(
    () =>
      tasks.filter(
        (task) =>
          task.environmentId === thread.environmentId &&
          task.archivedAt === null &&
          task.id !== thread.taskId,
      ),
    [tasks, thread.environmentId, thread.taskId],
  );
  const actions = useMemo<MenuAction[]>(
    () =>
      !supported
        ? []
        : [
            ...(thread.taskId == null
              ? []
              : [
                  { id: "task-open", title: "Open task" },
                  { id: "task-remove", title: "Move out of task" },
                ]),
            ...(available.length
              ? [
                  {
                    id: "task-move",
                    title: thread.taskId ? "Move to another task" : "Add to task",
                    subactions: available.map((task) => ({
                      id: `task-move:${task.id}`,
                      title: task.name,
                    })),
                  },
                ]
              : []),
          ],
    [supported, available, thread.taskId],
  );
  const handle = useCallback(
    (event: string) => {
      if (!supported) return;
      if (event === "task-open" && thread.taskId != null) {
        navigation.navigate("Task", { environmentId: thread.environmentId, taskId: thread.taskId });
        return;
      }
      const destination = available.find((task) => event === `task-move:${task.id}`);
      if (event !== "task-remove" && destination === undefined) return;
      void setTask({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, taskId: destination?.id ?? null },
      }).then((result) => {
        if (result._tag === "Failure")
          Alert.alert("Could not move thread", String(Cause.squash(result.cause)));
      });
    },
    [supported, navigation, available, thread, setTask],
  );
  return { actions, handle };
}
