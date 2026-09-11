import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Animated, Platform, Pressable, ScrollView, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkingTimer } from "./floating-working-control";
import {
  buildCancelQueuedRunCommand,
  resolveThreadQueueRowControls,
  resolveQueueDropBeforeRunId,
} from "./threadQueueControlPresentation";

type QueueTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function useThreadQueueWorkflow(target: QueueTarget) {
  return useAtomValue(environmentThreadDetails.queueWorkflowAtom(target));
}

export function useThreadQueuedCount(target: QueueTarget) {
  return useAtomValue(environmentThreadDetails.queuedCountAtom(target));
}

export function ThreadQueueSheet({ route }: StaticScreenProps<QueueTarget>) {
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const workflow = useThreadQueueWorkflow(target);
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun, "reorder queued message");
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun, "promote queued message");
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun, "remove queued message");
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const busyRef = useRef(false);
  const [draggedRunId, setDraggedRunId] = useState<RunId | null>(null);
  const rowLayouts = useRef(new Map<RunId, { y: number; height: number }>());
  const drag = useRef<{ runId: RunId; order: string } | null>(null);
  const [translation] = useState(() => new Animated.Value(0));
  const [selectedRunId, setSelectedRunId] = useState<RunId | null>(
    () => workflow?.queuedRuns[0]?.run.id ?? null,
  );
  const queuedRuns = workflow?.queuedRuns ?? [];
  const order = queuedRuns.map(({ run }) => run.id).join(",");

  useEffect(() => {
    if (drag.current && drag.current.order !== order) {
      drag.current = null;
      setDraggedRunId(null);
      translation.setValue(0);
    }
  }, [order, translation]);

  const move = async (runId: RunId, beforeRunId: RunId | null) => {
    if (busyRef.current || !workflow?.canReorder) return;
    busyRef.current = true;
    setBusyRunId(runId);
    void Haptics.selectionAsync();
    try {
      await reorder({ ...target, input: { threadId: target.threadId, runId, beforeRunId } });
    } finally {
      busyRef.current = false;
      setBusyRunId(null);
    }
  };

  const act = async (runId: RunId, action: string) => {
    if (busyRef.current) return;
    const index = queuedRuns.findIndex(({ run }) => run.id === runId);
    if (index < 0) return;
    if (action === "up" && index > 0) {
      await move(runId, queuedRuns[index - 1]!.run.id);
      return;
    }
    if (action === "down" && index < queuedRuns.length - 1) {
      await move(runId, queuedRuns[index + 2]?.run.id ?? null);
      return;
    }
    if (action !== "steer" && action !== "remove") return;
    busyRef.current = true;
    setBusyRunId(runId);
    void Haptics.selectionAsync();
    try {
      if (action === "remove") {
        await cancel(buildCancelQueuedRunCommand({ ...target, runId }));
      } else if (workflow?.activeRun && workflow.canPromoteToSteer) {
        await promote({
          ...target,
          input: {
            threadId: target.threadId,
            queuedRunId: runId,
            targetRunId: workflow.activeRun.id,
          },
        });
      }
    } finally {
      busyRef.current = false;
      setBusyRunId(null);
    }
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View
        collapsable={false}
        className="flex-1 bg-sheet"
        style={{ paddingBottom: insets.bottom }}
      >
        <View className="flex-row items-center justify-between px-5 pt-5 pb-2">
          <Text accessibilityRole="header" className="min-w-0 flex-1 font-t3-semibold text-lg">
            Queued messages <Text className="text-foreground-muted">{queuedRuns.length}</Text>
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.goBack()}
            className="min-h-12 justify-center px-3 active:opacity-70"
          >
            <Text className="font-t3-medium text-base text-primary">Done</Text>
          </Pressable>
        </View>
        <View className="gap-2 px-5 pb-4">
          {workflow?.activeRun?.startedAt ? (
            <WorkingTimer
              startedAt={new Date(workflow.activeRun.startedAt.epochMilliseconds).toISOString()}
            />
          ) : null}
          <Text className="text-sm text-foreground-muted">
            {queuedRuns.length === 0
              ? "No messages waiting in this queue."
              : "Queued messages run in order after this turn."}
          </Text>
        </View>
        <ScrollView
          className="flex-1"
          scrollEnabled={draggedRunId === null}
          contentContainerClassName="px-5 pb-6"
        >
          {queuedRuns.map(({ run, text, attachments }, index) => {
            const controls = resolveThreadQueueRowControls({
              busy: busyRunId !== null || draggedRunId !== null,
              canPromoteToSteer: workflow?.canPromoteToSteer ?? false,
              canReorder: workflow?.canReorder ?? false,
              index,
              queuedCount: queuedRuns.length,
              text,
            });
            const title =
              controls.displayText || (attachments.length > 0 ? "Attachments" : "Queued message");
            return (
              <View
                key={run.id}
                style={{ zIndex: draggedRunId === run.id ? 1 : 0 }}
                onLayout={({ nativeEvent }) => rowLayouts.current.set(run.id, nativeEvent.layout)}
              >
                <Animated.View
                  className="flex-row items-center gap-3 border-b border-border bg-sheet py-4"
                  style={
                    draggedRunId === run.id
                      ? { transform: [{ translateY: translation }], zIndex: 1, opacity: 0.85 }
                      : undefined
                  }
                >
                  <Text className="w-5 text-sm tabular-nums text-foreground-muted">
                    {index + 1}
                  </Text>
                  <View className="min-w-0 flex-1 gap-2">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={title}
                      accessibilityState={{ expanded: selectedRunId === run.id }}
                      disabled={busyRunId !== null || draggedRunId !== null}
                      onPress={() => setSelectedRunId(selectedRunId === run.id ? null : run.id)}
                      className="min-h-12 justify-center"
                    >
                      <Text className="text-base">{title}</Text>
                    </Pressable>
                    {selectedRunId === run.id ? (
                      <View className="flex-row flex-wrap gap-2">
                        {workflow?.canPromoteToSteer ? (
                          <Pressable
                            accessibilityRole="button"
                            disabled={!controls.canSteer}
                            onPress={() => void act(run.id, "steer")}
                            className="min-h-12 justify-center rounded-xl bg-primary px-3 disabled:opacity-40"
                          >
                            <Text className="font-t3-medium text-sm text-primary-foreground">
                              Steer now
                            </Text>
                          </Pressable>
                        ) : null}
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Remove queued message"
                          disabled={!controls.canDismiss}
                          onPress={() => void act(run.id, "remove")}
                          className="min-h-12 justify-center rounded-xl bg-card px-3 disabled:opacity-40"
                        >
                          <Text className="text-sm">Remove</Text>
                        </Pressable>
                      </View>
                    ) : null}
                    {attachments.length > 0 ? (
                      <Text className="text-xs text-foreground-muted">
                        {attachments.length} attachment{attachments.length === 1 ? "" : "s"}
                      </Text>
                    ) : null}
                  </View>
                  <ControlPillMenu
                    accessibilityLabel={`Actions for queued message ${index + 1}`}
                    actions={[
                      {
                        id: "steer",
                        title: "Steer now",
                        attributes: { disabled: !controls.canSteer },
                        image: Platform.OS === "ios" ? "arrow.turn.left.up" : "arrow_upward",
                      },
                      { id: "up", title: "Move up", attributes: { disabled: !controls.canMoveUp } },
                      {
                        id: "down",
                        title: "Move down",
                        attributes: { disabled: !controls.canMoveDown },
                      },
                      {
                        id: "remove",
                        title: "Remove",
                        attributes: { disabled: !controls.canDismiss, destructive: true },
                      },
                    ]}
                    onPressAction={({ nativeEvent }) => void act(run.id, nativeEvent.event)}
                  >
                    <View className="h-12 w-10 items-center justify-center">
                      <SymbolView
                        name="ellipsis"
                        size={18}
                        tintColorClassName="accent-foreground-muted"
                      />
                    </View>
                  </ControlPillMenu>
                  {workflow?.canReorder && queuedRuns.length > 1 ? (
                    <QueueDragHandle
                      disabled={busyRunId !== null}
                      title={title}
                      canMoveUp={controls.canMoveUp}
                      canMoveDown={controls.canMoveDown}
                      onStep={(action) => void act(run.id, action)}
                      onStart={() => {
                        drag.current = { runId: run.id, order };
                        translation.setValue(0);
                        setDraggedRunId(run.id);
                        void Haptics.selectionAsync();
                      }}
                      onMove={(y) => translation.setValue(y)}
                      onEnd={(y, success) => {
                        const started = drag.current;
                        drag.current = null;
                        setDraggedRunId(null);
                        translation.setValue(0);
                        // A remote reorder or a newly started run invalidates this drag.
                        if (!success || started?.order !== order || started.runId !== run.id)
                          return;
                        const before = resolveQueueDropBeforeRunId(
                          queuedRuns.map(({ run: item }) => ({
                            id: item.id,
                            ...rowLayouts.current.get(item.id),
                          })),
                          run.id,
                          y,
                        );
                        if (before !== undefined) void move(run.id, before);
                      }}
                    />
                  ) : null}
                </Animated.View>
              </View>
            );
          })}
          {workflow?.canReorder && queuedRuns.length > 1 ? (
            <Text className="pt-5 text-center text-xs text-foreground-muted">
              Drag the handles to reorder
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </GestureHandlerRootView>
  );
}

function QueueDragHandle(props: {
  disabled: boolean;
  title: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onStep: (action: "up" | "down") => void;
  onStart: () => void;
  onMove: (y: number) => void;
  onEnd: (y: number, success: boolean) => void;
}) {
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!props.disabled)
        .minDistance(0)
        .shouldCancelWhenOutside(false)
        .runOnJS(true)
        .onStart(() => latest.current.onStart())
        .onUpdate((event) => latest.current.onMove(event.translationY))
        .onFinalize((event, success) => latest.current.onEnd(event.translationY, success)),
    [props.disabled],
  );
  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Reorder ${props.title}`}
        accessibilityState={{ disabled: props.disabled }}
        accessibilityActions={[
          ...(props.canMoveUp ? [{ name: "decrement", label: "Move up" }] : []),
          ...(props.canMoveDown ? [{ name: "increment", label: "Move down" }] : []),
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (props.disabled) return;
          if (nativeEvent.actionName === "decrement" && props.canMoveUp) props.onStep("up");
          if (nativeEvent.actionName === "increment" && props.canMoveDown) props.onStep("down");
        }}
        className="h-12 w-10 items-center justify-center"
      >
        <SymbolView
          name="line.3.horizontal"
          size={18}
          tintColorClassName="accent-foreground-muted"
        />
      </View>
    </GestureDetector>
  );
}
