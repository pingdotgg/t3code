import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Animated, Modal, Pressable, FlatList, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { useTasks } from "../../state/tasks";
import { useThreadShells } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { pendingThreadOrderAtom } from "../../state/thread-order";
import { TaskActionsMenu } from "../tasks/TaskActionsMenu";
import { useThreadListActions } from "../home/useThreadListActions";
import { nextMobileTaskSnoozeExpiry } from "./taskOrder";
import { type TaskOrderRow } from "@t3tools/client-runtime/state/task-grouping";
import { useMobileTaskOrder, useMobileTaskMovePlanner } from "./use-mobile-task-order";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { ArrangementRow, DragHandle } from "./ArrangementDrag";
import { threadDragGapOffset } from "./threadDragGap";
import { threadDragAction, type ThreadMoveDestination } from "./threadOrder";
import {
  taskArrangementBlock,
  taskArrangementDestination,
  taskArrangementInsertionOffset,
  type TaskArrangementRow,
  type TaskArrangementDestination,
} from "./taskArrangement";

type Drag = {
  version: string;
  sourceId: string;
  startY: number;
  translation: number;
  destination: TaskArrangementDestination | null;
};

export function TaskArrangementSheet({ onClose }: { onClose: () => void }) {
  const tasks = useTasks();
  const threads = useThreadShells();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const pending = useAtomValue(pendingThreadOrderAtom);
  const actions = useThreadListActions();
  const order = useMobileTaskOrder();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const insets = useSafeAreaInsets();
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const wakeAt = nextMobileTaskSnoozeExpiry(tasks, threads, now);
    if (wakeAt === null) return;
    const timer = setTimeout(
      () => setNow(new Date().toISOString()),
      Math.min(Math.max(0, wakeAt - Date.now()) + 1, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [tasks, threads, now]);
  const planner = useMobileTaskMovePlanner(now);
  const rows = useMemo(() => {
    const result: TaskArrangementRow[] = [];
    let offset = 0;
    for (const section of ["pinned", "active", "snoozed", "settled"] as const) {
      // Empty destination shelves remain available for lifecycle drops.
      result.push({
        key: section,
        label: `${section[0]!.toUpperCase()}${section.slice(1)}`,
        section,
        offset,
        height: 48,
      });
      offset += 48;
      for (const row of planner.shelves[section]) {
        result.push({
          key: row.id,
          label: row.kind === "task" ? row.entity.name : row.entity.title,
          row,
          section,
          offset,
          height: 56,
        });
        offset += 56;
        if (row.kind !== "task" || !expanded.has(row.id)) continue;
        for (const member of planner.memberRows.get(`${row.environmentId}:${row.entity.id}`) ??
          []) {
          result.push({
            key: member.id,
            label: member.kind === "thread" ? member.entity.title : "",
            row: member,
            member: true,
            section,
            offset,
            height: 56,
          });
          offset += 56;
        }
      }
    }
    return result;
  }, [planner, expanded]);
  const canChangeSection = (row: TaskOrderRow, section: "pinned" | "active" | "settled") => {
    if (row.kind !== "thread" || row.entity.taskId != null) return false;
    const caps = configs.get(row.environmentId)?.environment.capabilities;
    if (section === "settled") return caps?.threadSettlement === true;
    if (!(section === "pinned" ? caps?.threadPinReorder : caps?.threadActiveReorder)) return false;
    if ((section === "pinned" || row.entity.pinnedAt != null) && !caps?.threadPinning) return false;
    if (section === "active" && row.entity.settledOverride === "settled" && !caps?.threadSettlement)
      return false;
    if (section === "active" && row.entity.snoozedUntil != null && !caps?.threadSnooze)
      return false;
    return true;
  };
  const move = (row: TaskOrderRow, destination: ThreadMoveDestination) =>
    row.kind === "thread"
      ? actions.moveThread(row.entity, destination)
      : order.move(row, destination);
  const list = useRef<FlatList<TaskArrangementRow>>(null);
  const geometry = useRef({ height: 0, offset: 0 });
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const [preview, setPreview] = useState<Drag | null>(null);
  const translateY = useRef(new Animated.Value(0)).current;
  const version = rows
    .map(
      (item) =>
        `${item.key}:${item.section}:${item.row?.activeOrderKey}:${item.row?.pinOrderKey}:${item.row?.entity.snoozedUntil}:${item.row?.entity.settledOverride}:${item.row?.kind === "thread" ? item.row.entity.taskId : ""}`,
    )
    .join("|");
  const latest = useRef({ rows, planner, canChangeSection, move, version });
  latest.current = { rows, planner, canChangeSection, move, version };
  function stop() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    drag.current = null;
    setPreview(null);
  }
  useEffect(() => {
    stop();
  }, [version]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  function update(translation: number) {
    const current = drag.current;
    if (!current) return;
    current.translation = translation;
    const { height, offset } = geometry.current;
    const y = current.startY + translation;
    translateY.setValue(Math.max(0, Math.min(height - 56, y - 28)));
    const destination =
      y < 0 || y > height
        ? null
        : taskArrangementDestination({
            ...latest.current,
            sourceId: current.sourceId,
            contentY: Math.max(0, y + offset),
          });
    if (
      current.destination?.targetId !== destination?.targetId ||
      current.destination?.section !== destination?.section ||
      current.destination?.placement !== destination?.placement
    ) {
      current.destination = destination;
      setPreview({ ...current });
    }
  }
  function start(item: TaskArrangementRow) {
    if (!item.row || preview || order.busy || pending) return;
    drag.current = {
      version,
      sourceId: item.key,
      startY: item.offset + 28 - geometry.current.offset,
      translation: 0,
      destination: null,
    };
    setPreview({ ...drag.current });
    update(0);
    let last = performance.now();
    const tick = () => {
      const current = drag.current;
      if (!current) return;
      const timestamp = performance.now();
      const dt = Math.min(timestamp - last, 32);
      last = timestamp;
      const bounds = geometry.current;
      const y = current.startY + current.translation;
      const speed =
        y < 48
          ? -Math.min(1, (48 - y) / 48)
          : y > bounds.height - 48
            ? Math.min(1, (y - bounds.height + 48) / 48)
            : 0;
      const tail = latest.current.rows.at(-1);
      const maximum = Math.max(0, (tail ? tail.offset + tail.height : 0) - bounds.height);
      const offset = Math.max(0, Math.min(maximum, bounds.offset + speed * dt * 0.5));
      if (offset !== bounds.offset) {
        bounds.offset = offset;
        list.current?.scrollToOffset({ offset, animated: false });
        update(current.translation);
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }
  function end(cancelled: boolean) {
    const current = drag.current;
    const row = current && latest.current.planner.byId.get(current.sourceId);
    if (cancelled || !current?.destination || !row || current.version !== latest.current.version) {
      stop();
      return;
    }
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    drag.current = null;
    void latest.current.move(row, current.destination).finally(stop);
  }
  const visiblePreview = preview?.version === version ? preview : null;
  const block = visiblePreview ? taskArrangementBlock(rows, visiblePreview.sourceId) : null;
  const insertion = visiblePreview?.destination
    ? taskArrangementInsertionOffset(rows, visiblePreview.destination)
    : null;
  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View
          className="flex-1 bg-screen"
          style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
        >
          <View className="flex-row items-center justify-between px-5 py-3">
            <Text className="flex-1 text-xl font-t3-semibold">Arrange tasks and threads</Text>
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              className="min-h-11 justify-center"
            >
              <Text>Done</Text>
            </Pressable>
          </View>
          <Text className="px-5 pb-3 text-sm text-foreground-muted">
            Drag or use arrows to reorder. Expand a task to arrange its members.
          </Text>
          <View
            className="flex-1"
            style={{ overflow: "hidden" }}
            onLayout={(event) => {
              geometry.current.height = event.nativeEvent.layout.height;
            }}
          >
            <FlatList
              ref={list}
              data={rows}
              keyExtractor={(item) => item.key}
              scrollEnabled={visiblePreview === null}
              removeClippedSubviews={false}
              onScroll={(event) => {
                geometry.current.offset = event.nativeEvent.contentOffset.y;
              }}
              scrollEventThrottle={16}
              getItemLayout={(_, index) => ({
                length: rows[index]!.height,
                offset: rows[index]!.offset,
                index,
              })}
              renderItem={({ item }) => {
                const row = item.row;
                const up = row != null && planner.canMove(row, "up");
                const down = row != null && planner.canMove(row, "down");
                const sectionActions = row
                  ? (["pinned", "active", "settled"] as const).flatMap((section) => {
                      const label = threadDragAction(item.section, section);
                      return section !== item.section && label && canChangeSection(row, section)
                        ? [{ name: section, label }]
                        : [];
                    })
                  : [];
                const lifted =
                  block !== null &&
                  item.offset >= block.source.offset &&
                  item.offset < block.source.offset + block.height;
                return (
                  <ArrangementRow
                    height={item.height}
                    lifted={lifted}
                    dragging={visiblePreview !== null}
                    offset={
                      block && insertion !== null && !lifted
                        ? threadDragGapOffset(
                            item.offset,
                            block.source.offset,
                            block.height,
                            insertion,
                          )
                        : 0
                    }
                  >
                    {!row ? (
                      <Text className="font-t3-semibold text-foreground-muted">{item.label}</Text>
                    ) : (
                      <>
                        {item.member ? <View style={{ width: 20 }} /> : null}
                        {row.kind === "task" ? (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Expand ${item.label}`}
                            accessibilityState={{ expanded: expanded.has(row.id) }}
                            className="min-h-11 min-w-8 justify-center"
                            onPress={() =>
                              setExpanded((keys) => {
                                const next = new Set(keys);
                                if (next.has(row.id)) next.delete(row.id);
                                else next.add(row.id);
                                return next;
                              })
                            }
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
                            disabled={
                              order.busy || pending !== null || !(direction === "up" ? up : down)
                            }
                            onPress={() => void move(row, direction)}
                            style={{
                              opacity:
                                order.busy || pending !== null || !(direction === "up" ? up : down)
                                  ? 0.3
                                  : 1,
                            }}
                            className="min-h-11 min-w-8 items-center justify-center"
                          >
                            <SymbolView
                              name={direction === "up" ? "arrow.up" : "arrow.down"}
                              size={18}
                            />
                          </Pressable>
                        ))}
                        <DragHandle
                          title={item.label}
                          disabled={
                            order.busy ||
                            pending !== null ||
                            (!up && !down && !sectionActions.length)
                          }
                          canMoveUp={up}
                          canMoveDown={down}
                          sectionActions={sectionActions}
                          onSectionMove={(section) =>
                            void move(row, { section, targetId: null, placement: "before" })
                          }
                          onStep={(direction) => void move(row, direction)}
                          onStart={() => start(item)}
                          onMove={update}
                          onEnd={end}
                        />
                        {row.kind === "task" ? (
                          <TaskActionsMenu task={row.entity} onNavigate={onClose} />
                        ) : (
                          <ControlPillMenu
                            actions={[
                              {
                                id:
                                  row.entity.settledOverride === "settled" ? "unsettle" : "settle",
                                title:
                                  row.entity.settledOverride === "settled" ? "Un-settle" : "Settle",
                              },
                              ...(row.entity.taskId == null
                                ? [
                                    {
                                      id: row.entity.pinnedAt ? "unpin" : "pin",
                                      title: row.entity.pinnedAt ? "Unpin" : "Pin",
                                    },
                                  ]
                                : []),
                              ...(row.entity.snoozedUntil != null
                                ? [{ id: "unsnooze", title: "Unsnooze" }]
                                : []),
                            ]}
                            onPressAction={({ nativeEvent: { event } }) => {
                              if (event === "settle") void actions.settleThread(row.entity);
                              else if (event === "unsettle")
                                void actions.unsettleThread(row.entity);
                              else if (event === "pin") void actions.pinThread(row.entity);
                              else if (event === "unpin") void actions.unpinThread(row.entity);
                              else if (event === "unsnooze")
                                void actions.unsnoozeThread(row.entity);
                            }}
                          >
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Actions for ${item.label}`}
                              className="min-h-11 min-w-8 items-center justify-center"
                            >
                              <SymbolView name="ellipsis" size={18} />
                            </Pressable>
                          </ControlPillMenu>
                        )}
                      </>
                    )}
                  </ArrangementRow>
                );
              }}
            />
            {block ? (
              <Animated.View
                pointerEvents="none"
                className="absolute left-5 right-5 rounded-xl border border-border bg-screen px-4"
                style={{ top: 0, height: block.height, transform: [{ translateY }] }}
              >
                {rows
                  .filter(
                    (item) =>
                      item.offset >= block.source.offset &&
                      item.offset < block.source.offset + block.height,
                  )
                  .map((item) => (
                    <View key={item.key} style={{ height: item.height, justifyContent: "center" }}>
                      <Text numberOfLines={2}>{item.label}</Text>
                    </View>
                  ))}
              </Animated.View>
            ) : null}
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}
