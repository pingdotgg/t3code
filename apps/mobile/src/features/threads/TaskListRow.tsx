import { mobileTaskItemsAreEqual } from "./taskListEquality";
import { useTaskNavigation } from "../tasks/useTaskNavigation";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { taskOrderRow } from "@t3tools/client-runtime/state/task-grouping";
import { useMobileTaskOrder } from "./use-mobile-task-order";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadArrangementOpenAtom } from "../../state/thread-order";
import { memo } from "react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { TaskActionsMenu } from "../tasks/TaskActionsMenu";
import { useMobileTaskList, useMobileTaskListActions } from "./use-mobile-task-list";
import { mobileTaskKey, type MobileTaskListItem } from "./taskList";
import type { TaskCreateContext } from "../tasks/taskCreateContext";

export const TaskListRow = memo(
  function TaskListRow({
    item,
    canMoveUp,
    canMoveDown,
  }: {
    item: MobileTaskListItem;
    canMoveUp: boolean;
    canMoveDown: boolean;
  }) {
    const navigateTask = useTaskNavigation(item.task);
    const order = useMobileTaskOrder();
    const toggle = useMobileTaskListActions();
    const task = item.task;
    if (item.type === "task-new-thread")
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`New thread in ${task.name}`}
          onPress={() => navigateTask("new-thread")}
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
            toggle(
              item.type === "task-slim" ? `parked:${mobileTaskKey(task)}` : mobileTaskKey(task),
            )
          }
          className="min-h-11 min-w-11 items-center justify-center"
        >
          <SymbolView name={item.expanded ? "chevron.down" : "chevron.right"} size={14} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => navigateTask("open")}
          className="min-h-11 flex-1 justify-center py-2"
        >
          {item.type === "task-card" ? (
            <View className="mb-1 flex-row items-center gap-1.5">
              <ProjectFavicon
                environmentId={task.environmentId}
                projectTitle={item.primaryProject?.title ?? "Project"}
                workspaceRoot={item.primaryProject?.workspaceRoot}
                faviconPath={item.primaryProject?.faviconPath}
                size={14}
              />
              <Text numberOfLines={1} className="flex-1 text-xs text-foreground-muted">
                {item.primaryProject?.title ?? "Project"}
              </Text>
            </View>
          ) : null}
          <Text numberOfLines={1} className="font-t3-semibold">
            {task.name}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {item.count} threads
            {item.status !== "idle" ? ` · ${item.status}` : ""}
            {item.snoozed
              ? ` · ${item.snoozeWakeLabelText ?? "Snoozed"}`
              : task.settledOverride === "settled"
                ? " · Settled"
                : ""}
          </Text>
        </Pressable>
        <TaskActionsMenu
          task={task}
          members={item.members}
          extraActions={[
            {
              id: "move-up",
              title: "Move up",
              attributes: {
                disabled: order.busy || !canMoveUp,
              },
            },
            {
              id: "move-down",
              title: "Move down",
              attributes: {
                disabled: order.busy || !canMoveDown,
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
  },
  (previous, next) =>
    previous.canMoveUp === next.canMoveUp &&
    previous.canMoveDown === next.canMoveDown &&
    mobileTaskItemsAreEqual(previous.item, next.item),
);

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
