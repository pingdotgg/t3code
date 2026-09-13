import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { taskOrderRow } from "@t3tools/client-runtime/state/task-grouping";
import { useMobileTaskOrder, readMobileTaskMove } from "./use-mobile-task-order";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadArrangementOpenAtom } from "../../state/thread-order";
import { memo } from "react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { TaskActionsMenu } from "../tasks/TaskActionsMenu";
import { useMobileTaskList } from "./use-mobile-task-list";
import { mobileTaskKey, type MobileTaskListItem } from "./taskList";
import type { TaskCreateContext } from "../tasks/taskCreateContext";

export const TaskListRow = memo(function TaskListRow({ item }: { item: MobileTaskListItem }) {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const { layout } = useAdaptiveWorkspaceLayout();
  const openTask = () => {
    const state = navigation.getState();
    const name = state.routes[state.index]?.name;
    const params = { environmentId: item.task.environmentId, taskId: item.task.id };
    if (!layout.usesSplitView || name === "Home") navigation.push("Task", params);
    else if (name === "Task") navigation.setParams(params);
    else navigation.replace("Task", params);
  };
  const order = useMobileTaskOrder();
  const { toggle } = useMobileTaskList();
  const task = item.task;
  const params = { environmentId: task.environmentId, taskId: task.id };
  if (item.type === "task-new-thread")
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`New thread in ${task.name}`}
        onPress={() =>
          navigation.navigate("NewTaskSheet", {
            screen: "NewTaskDraft",
            params: { ...params, projectId: task.primaryProjectId },
          })
        }
        className="ml-9 mr-4 min-h-11 flex-row items-center gap-2 px-3"
      >
        <SymbolView name="plus" size={15} />
        <Text className="text-sm text-foreground-muted">New thread</Text>
      </Pressable>
    );
  if (item.type === "task-subshelf-header")
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: item.expanded }}
        onPress={() => toggle(mobileTaskKey(task), true)}
        className="ml-9 mr-4 min-h-11 flex-row items-center gap-2 px-3"
      >
        <SymbolView name={item.expanded ? "chevron.down" : "chevron.right"} size={12} />
        <Text className="text-xs text-foreground-muted">Settled ({item.count})</Text>
      </Pressable>
    );
  return (
    <View
      className={`mx-3 mt-2 flex-row items-center rounded-xl border border-border px-2 ${item.selected ? "bg-primary/10" : ""} ${item.type === "task-card" ? "min-h-16" : "min-h-11"}`}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.expanded ? "Collapse" : "Expand"} ${task.name}`}
        accessibilityState={{ expanded: item.expanded }}
        onPress={() =>
          toggle(item.type === "task-slim" ? `parked:${mobileTaskKey(task)}` : mobileTaskKey(task))
        }
        className="min-h-11 min-w-11 items-center justify-center"
      >
        <SymbolView name={item.expanded ? "chevron.down" : "chevron.right"} size={14} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={openTask}
        className="min-h-11 flex-1 justify-center py-2"
      >
        <Text numberOfLines={1} className="font-t3-semibold">
          {task.name}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {item.count} threads
          {item.status !== "idle"
            ? ` · ${item.status}`
            : item.snoozed
              ? " · Snoozed"
              : task.settledOverride === "settled"
                ? " · Settled"
                : ""}
        </Text>
      </Pressable>
      <TaskActionsMenu
        task={task}
        extraActions={[
          {
            id: "move-up",
            title: "Move up",
            attributes: {
              disabled: order.busy || readMobileTaskMove(taskOrderRow(task), "up") === null,
            },
          },
          {
            id: "move-down",
            title: "Move down",
            attributes: {
              disabled: order.busy || readMobileTaskMove(taskOrderRow(task), "down") === null,
            },
          },
          { id: "arrange", title: "Arrange tasks and threads…" },
        ]}
        onExtraAction={(event) => {
          if (event === "arrange") appAtomRegistry.set(threadArrangementOpenAtom, true);
          else if (event === "move-up" || event === "move-down")
            void order.move(taskOrderRow(task), event === "move-up" ? "up" : "down");
        }}
      />
    </View>
  );
});

export function TaskCreateListButton(context: TaskCreateContext) {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const { capableIds } = useMobileTaskList();
  if (
    capableIds.size === 0 ||
    (context.environmentId !== undefined &&
      ![...capableIds].some((id) => id === context.environmentId))
  )
    return null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => navigation.navigate("TaskCreate", context)}
      className="mx-4 min-h-11 flex-row items-center gap-2"
    >
      <SymbolView name="folder.badge.plus" size={17} />
      <Text className="text-sm text-foreground-muted">New task</Text>
    </Pressable>
  );
}
