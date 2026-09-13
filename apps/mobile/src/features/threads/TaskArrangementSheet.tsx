import { useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Modal, Pressable, FlatList, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { useTasks } from "../../state/tasks";
import { useThreadShells } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import { TaskActionsMenu } from "../tasks/TaskActionsMenu";
import { useThreadListActions } from "../home/useThreadListActions";
import { mobileOrderRows, mobileOrderShelf } from "./taskOrder";
import {
  sortTaskRowsByOrderKey,
  threadOrderRow,
  type TaskOrderRow,
} from "@t3tools/client-runtime/state/task-grouping";
import { useMobileTaskOrder, readMobileTaskMove } from "./use-mobile-task-order";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";

export function TaskArrangementSheet({ onClose }: { onClose: () => void }) {
  const tasks = useTasks();
  const threads = useThreadShells();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const queued = useAtomValue(queuedThreadKeysAtom);
  const actions = useThreadListActions();
  const order = useMobileTaskOrder();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const insets = useSafeAreaInsets();
  const now = new Date().toISOString();
  const rows = useMemo(() => {
    const top = mobileOrderRows({
      tasks,
      threads,
      capableIds: new Set(
        [...configs].flatMap(([id, c]) => (c.environment.capabilities.tasks === true ? [id] : [])),
      ),
    });
    const result: { key: string; label: string; row?: TaskOrderRow; member?: boolean }[] = [];
    for (const shelf of ["pinned", "active", "snoozed", "settled"] as const) {
      const section = top.filter((row) => mobileOrderShelf(row, now, queued) === shelf);
      if (!section.length) continue;
      result.push({ key: shelf, label: `${shelf[0]!.toUpperCase()}${shelf.slice(1)}` });
      const sorted =
        shelf === "pinned" || shelf === "active" ? sortTaskRowsByOrderKey(section, shelf) : section;
      for (const row of sorted) {
        result.push({
          key: row.id,
          label: row.kind === "task" ? row.entity.name : row.entity.title,
          row,
        });
        if (row.kind !== "task" || !expanded.has(row.id)) continue;
        const members = threads
          .filter(
            (thread) =>
              thread.taskId === row.entity.id &&
              thread.environmentId === row.environmentId &&
              thread.archivedAt === null,
          )
          .map(threadOrderRow);
        for (const member of sortTaskRowsByOrderKey(members, "active"))
          result.push({
            key: member.id,
            label: member.kind === "thread" ? member.entity.title : "",
            row: member,
            member: true,
          });
      }
    }
    return result;
  }, [tasks, threads, configs, queued, expanded, now]);
  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View
        className="flex-1 bg-screen"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="flex-row items-center justify-between px-5 py-3">
          <Text className="text-xl font-t3-semibold">Arrange tasks and threads</Text>
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            className="min-h-11 justify-center"
          >
            <Text>Done</Text>
          </Pressable>
        </View>
        <Text className="px-5 pb-3 text-sm text-foreground-muted">
          Move rows up or down. Expand a task to arrange its members.
        </Text>
        <FlatList
          data={rows}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => {
            const row = item.row;
            if (!row)
              return (
                <Text className="px-5 py-3 font-t3-semibold text-foreground-muted">
                  {item.label}
                </Text>
              );
            return (
              <View
                className={`min-h-14 flex-row items-center gap-2 pr-4 ${item.member ? "pl-10" : "pl-4"}`}
              >
                {row.kind === "task" ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Expand ${item.label}`}
                    accessibilityState={{ expanded: expanded.has(row.id) }}
                    onPress={() =>
                      setExpanded((keys) => {
                        const next = new Set(keys);
                        if (next.has(row.id)) next.delete(row.id);
                        else next.add(row.id);
                        return next;
                      })
                    }
                    className="min-h-11 min-w-11 justify-center"
                  >
                    <SymbolView
                      name={expanded.has(row.id) ? "chevron.down" : "chevron.right"}
                      size={14}
                    />
                  </Pressable>
                ) : null}
                <Text numberOfLines={2} className="flex-1">
                  {item.label}
                </Text>
                {(["up", "down"] as const).map((direction) => (
                  <Pressable
                    key={direction}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${item.label} ${direction}`}
                    disabled={order.busy || readMobileTaskMove(row, direction) === null}
                    onPress={() => void order.move(row, direction)}
                    style={{
                      opacity: order.busy || readMobileTaskMove(row, direction) === null ? 0.3 : 1,
                    }}
                    className="min-h-11 min-w-11 items-center justify-center"
                  >
                    <SymbolView name={direction === "up" ? "arrow.up" : "arrow.down"} size={18} />
                  </Pressable>
                ))}
                {row.kind === "task" ? (
                  <TaskActionsMenu task={row.entity} />
                ) : (
                  <ControlPillMenu
                    actions={[
                      {
                        id: row.entity.settledOverride === "settled" ? "unsettle" : "settle",
                        title: row.entity.settledOverride === "settled" ? "Un-settle" : "Settle",
                      },
                      ...(row.entity.taskId == null
                        ? [
                            {
                              id: row.entity.pinnedAt ? "unpin" : "pin",
                              title: row.entity.pinnedAt ? "Unpin" : "Pin",
                            },
                          ]
                        : []),
                    ]}
                    onPressAction={({ nativeEvent: { event } }) => {
                      if (event === "settle") void actions.settleThread(row.entity);
                      else if (event === "unsettle") void actions.unsettleThread(row.entity);
                      else if (event === "pin") void actions.pinThread(row.entity);
                      else if (event === "unpin") void actions.unpinThread(row.entity);
                    }}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Actions for ${item.label}`}
                      className="min-h-11 min-w-11 items-center justify-center"
                    >
                      <SymbolView name="ellipsis" size={18} />
                    </Pressable>
                  </ControlPillMenu>
                )}
              </View>
            );
          }}
        />
      </View>
    </Modal>
  );
}
