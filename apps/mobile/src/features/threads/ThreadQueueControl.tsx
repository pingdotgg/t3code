import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import type { ChatAttachment, EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Animated, Platform, Pressable, ScrollView, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Reanimated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { useAssetUrl } from "../../state/assets";
import { beginQueuedRunEdit, useQueuedRunEdit } from "../../state/queued-run-edit";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildCancelQueuedRunCommand,
  resolveQueueDragBeforeRunId,
  resolveQueueDropBeforeRunId,
  resolveThreadQueueRowControls,
} from "./threadQueueControlPresentation";
import { threadDragGapOffset } from "./threadDragGap";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
const REMOVE_ACTION_WIDTH = 76;
const THUMBNAIL_LIMIT = 3;

type QueueTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
type QueueAction = "steer" | "edit" | "up" | "down" | "remove";
type QueueRowLayout = { readonly id: RunId; readonly y?: number; readonly height?: number };

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
  const theme = useUniwindTheme();
  const workflow = useThreadQueueWorkflow(target);
  const threadKey = scopedThreadKey(target.environmentId, target.threadId);
  const editing = useQueuedRunEdit(threadKey);
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun, "reorder queued message");
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun, "promote queued message");
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun, "remove queued message");
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const busyRef = useRef(false);
  const [draggedRunId, setDraggedRunId] = useState<RunId | null>(null);
  const [previewBeforeRunId, setPreviewBeforeRunId] = useState<RunId | null | undefined>();
  const [dragRows, setDragRows] = useState<ReadonlyArray<QueueRowLayout> | null>(null);
  const rowLayouts = useRef(new Map<RunId, { y: number; height: number }>());
  const drag = useRef<{
    runId: RunId;
    order: string;
    beforeRunId: RunId | null | undefined;
    rows: ReadonlyArray<QueueRowLayout>;
  } | null>(null);
  const [translation] = useState(() => new Animated.Value(0));
  const queuedRuns = workflow?.queuedRuns ?? [];
  const order = queuedRuns.map(({ run }) => run.id).join(",");

  useEffect(() => {
    if (drag.current && drag.current.order !== order) {
      drag.current = null;
      setDraggedRunId(null);
      setPreviewBeforeRunId(undefined);
      setDragRows(null);
      translation.setValue(0);
    }
  }, [order, translation]);

  // Nothing left to manage: the sheet closes rather than sitting on an empty
  // list the user has to dismiss themselves.
  const hadQueuedRuns = useRef(queuedRuns.length > 0);
  useEffect(() => {
    if (queuedRuns.length > 0) {
      hadQueuedRuns.current = true;
      return;
    }
    if (hadQueuedRuns.current) navigation.goBack();
  }, [navigation, queuedRuns.length]);

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

  const act = async (runId: RunId, action: QueueAction) => {
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
    if (action === "edit") {
      const entry = queuedRuns[index]!;
      void Haptics.selectionAsync();
      beginQueuedRunEdit(threadKey, {
        runId,
        messageId: entry.messageId,
        originalText: entry.text,
        existingAttachments: entry.attachments,
        ...(entry.context ? { context: entry.context } : {}),
      });
      navigation.goBack();
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

  const canReorder = workflow?.canReorder === true && queuedRuns.length > 1;
  const sourceLayout = dragRows?.find((row) => row.id === draggedRunId);
  const lastLayout = dragRows?.at(-1);
  const insertionOffset =
    previewBeforeRunId === undefined
      ? undefined
      : previewBeforeRunId === null
        ? lastLayout?.y === undefined || lastLayout.height === undefined
          ? undefined
          : lastLayout.y + lastLayout.height
        : dragRows?.find((row) => row.id === previewBeforeRunId)?.y;
  const queueRows = () =>
    queuedRuns.map(({ run }) => ({ id: run.id, ...rowLayouts.current.get(run.id) }));
  const content = (
    <ScrollView
      className="flex-1"
      scrollEnabled={draggedRunId === null}
      // The iOS header is translucent and floats over this view; UIKit has to
      // inset the content or the first row sits underneath the title.
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {queuedRuns.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          No messages waiting in this queue.
        </Text>
      ) : null}
      {queuedRuns.map(({ run, text, attachments }, index) => {
        const layout = dragRows?.find((row) => row.id === run.id);
        const offset =
          sourceLayout?.y !== undefined &&
          sourceLayout.height !== undefined &&
          layout?.y !== undefined &&
          insertionOffset !== undefined
            ? threadDragGapOffset(layout.y, sourceLayout.y, sourceLayout.height, insertionOffset)
            : 0;
        const controls = resolveThreadQueueRowControls({
          busy: busyRunId !== null || draggedRunId !== null,
          canPromoteToSteer: workflow?.canPromoteToSteer ?? false,
          canReorder: workflow?.canReorder ?? false,
          index,
          isEditing: editing?.runId === run.id,
          queuedCount: queuedRuns.length,
          text,
        });
        const title =
          controls.displayText || (attachments.length > 0 ? "Attachments" : "Queued message");
        return (
          <QueueShiftedRow
            key={run.id}
            offset={offset}
            dragging={draggedRunId !== null}
            lifted={draggedRunId === run.id}
            onLayout={({ nativeEvent }) => rowLayouts.current.set(run.id, nativeEvent.layout)}
          >
            <Animated.View
              className="flex-row items-center border-b border-border bg-sheet"
              style={
                draggedRunId === run.id
                  ? { transform: [{ translateY: translation }], zIndex: 1, opacity: 0.85 }
                  : undefined
              }
            >
              {canReorder ? (
                // Outside the swipeable: two pans on one row would race, and
                // the handle owns vertical movement while the row owns sideways.
                <QueueDragHandle
                  disabled={busyRunId !== null}
                  title={title}
                  canMoveUp={controls.canMoveUp}
                  canMoveDown={controls.canMoveDown}
                  onStep={(action) => void act(run.id, action)}
                  onStart={() => {
                    const rows = queueRows();
                    const beforeRunId = resolveQueueDragBeforeRunId(rows, run.id, 0);
                    drag.current = { runId: run.id, order, beforeRunId, rows };
                    translation.setValue(0);
                    setDragRows(rows);
                    setPreviewBeforeRunId(beforeRunId);
                    setDraggedRunId(run.id);
                    void Haptics.selectionAsync();
                  }}
                  onMove={(y) => {
                    const current = drag.current;
                    if (current?.runId !== run.id || current.order !== order) return;
                    translation.setValue(y);
                    const before = resolveQueueDragBeforeRunId(current.rows, run.id, y);
                    if (current.beforeRunId !== before) {
                      current.beforeRunId = before;
                      setPreviewBeforeRunId(before);
                    }
                  }}
                  onEnd={(y, success) => {
                    const started = drag.current;
                    const stop = () => {
                      if (drag.current !== started) return;
                      drag.current = null;
                      setDraggedRunId(null);
                      setPreviewBeforeRunId(undefined);
                      setDragRows(null);
                      translation.setValue(0);
                    };
                    // A remote reorder or a newly started run invalidates this drag.
                    if (!success || started?.order !== order || started.runId !== run.id) {
                      stop();
                      return;
                    }
                    const before = resolveQueueDropBeforeRunId(started.rows, run.id, y);
                    if (before === undefined) {
                      stop();
                      return;
                    }
                    const source = started.rows.find((row) => row.id === run.id);
                    const tail = started.rows.at(-1);
                    const insertion =
                      before === null
                        ? tail?.y !== undefined && tail.height !== undefined
                          ? tail.y + tail.height
                          : undefined
                        : started.rows.find((row) => row.id === before)?.y;
                    if (
                      source?.y !== undefined &&
                      source.height !== undefined &&
                      insertion !== undefined
                    ) {
                      Animated.timing(translation, {
                        toValue: insertion - source.y - (insertion > source.y ? source.height : 0),
                        duration: 160,
                        useNativeDriver: true,
                      }).start();
                    }
                    setPreviewBeforeRunId(before);
                    void move(run.id, before).finally(stop);
                  }}
                />
              ) : null}
              <QueueRowSwipeable
                enabled={draggedRunId === null && busyRunId === null && controls.canDismiss}
                background={theme["--color-sheet"]}
                onRemove={() => void act(run.id, "remove")}
              >
                <ControlPillMenu
                  accessibilityLabel={`Actions for queued message ${index + 1}`}
                  shouldOpenOnLongPress
                  actions={[
                    ...(workflow?.canPromoteToSteer
                      ? [
                          {
                            id: "steer",
                            title: "Steer now",
                            attributes: { disabled: !controls.canSteer },
                            image: Platform.OS === "ios" ? "arrow.turn.left.up" : "arrow_upward",
                          },
                        ]
                      : []),
                    {
                      id: "edit",
                      title: "Edit",
                      attributes: { disabled: !controls.canEdit },
                      image: Platform.OS === "ios" ? "pencil" : "edit",
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
                  onPressAction={({ nativeEvent }) =>
                    void act(run.id, nativeEvent.event as QueueAction)
                  }
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={title}
                    accessibilityHint="Opens this message in the composer for editing"
                    disabled={!controls.canEdit}
                    onPress={() => void act(run.id, "edit")}
                    className="min-h-14 flex-row items-center gap-2.5 py-2.5 active:opacity-70"
                  >
                    <QueueAttachmentThumbnails
                      environmentId={target.environmentId}
                      attachments={attachments}
                    />
                    <Text
                      className={
                        controls.isEditing
                          ? "min-w-0 flex-1 text-sm text-foreground-muted"
                          : "min-w-0 flex-1 text-sm text-foreground"
                      }
                      numberOfLines={1}
                    >
                      {title}
                    </Text>
                    {controls.isEditing ? (
                      <Text className="shrink-0 text-2xs uppercase tracking-wide text-primary">
                        Editing
                      </Text>
                    ) : null}
                    {workflow?.canPromoteToSteer ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Steer with message ${index + 1} now`}
                        disabled={!controls.canSteer}
                        onPress={() => void act(run.id, "steer")}
                        className="h-8 shrink-0 justify-center rounded-full bg-primary px-3 active:opacity-70 disabled:opacity-40"
                      >
                        <Text className="font-t3-medium text-xs text-primary-foreground">
                          Steer
                        </Text>
                      </Pressable>
                    ) : null}
                  </Pressable>
                </ControlPillMenu>
              </QueueRowSwipeable>
            </Animated.View>
          </QueueShiftedRow>
        );
      })}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // A plain formSheet screen never renders a stack header, so it comes from
    // a nested native stack inside the sheet (same shape as the git sheet).
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View collapsable={false} className="flex-1 bg-sheet">
          <ScreenStack style={{ flex: 1 }}>
            <Screen
              activityState={2}
              enabled
              isNativeStack
              screenId="thread-queue-sheet-native"
              scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
              style={{ backgroundColor: theme["--color-sheet"], flex: 1 }}
            >
              {content}
              <ScreenStackHeaderConfig
                backgroundColor="rgba(0,0,0,0)"
                color={theme["--color-foreground"]}
                hideBackButton
                hideShadow={false}
                title="Queued"
                titleColor={theme["--color-foreground"]}
                titleFontSize={18}
                titleFontWeight="800"
                translucent
              />
            </Screen>
          </ScreenStack>
        </View>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View collapsable={false} className="flex-1 bg-sheet">
        <AndroidSheetHeader title="Queued" onBack={() => navigation.goBack()} />
        {content}
      </View>
    </GestureHandlerRootView>
  );
}

function QueueShiftedRow(props: {
  readonly offset: number;
  readonly dragging: boolean;
  readonly lifted: boolean;
  readonly onLayout: React.ComponentProps<typeof View>["onLayout"];
  readonly children: React.ReactNode;
}) {
  const { dragging, offset } = props;
  const style = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: dragging
          ? withTiming(offset, { duration: 160, reduceMotion: ReduceMotion.System })
          : offset,
      },
    ],
  }));
  return (
    <Reanimated.View onLayout={props.onLayout} style={[style, { zIndex: props.lifted ? 1 : 0 }]}>
      {props.children}
    </Reanimated.View>
  );
}

/** Swipe left to remove, the one destructive action that needs no menu. */
function QueueRowSwipeable(props: {
  readonly enabled: boolean;
  readonly background: string;
  readonly onRemove: () => void;
  readonly children: React.ReactNode;
}) {
  const swipeableRef = useRef<SwipeableMethods | null>(null);
  return (
    <ReanimatedSwipeable
      ref={swipeableRef}
      enabled={props.enabled}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      // The sheet's own vertical scroll and the drag handle both move up and
      // down; a swipe has to be clearly sideways before it takes the gesture.
      failOffsetY={[-12, 12]}
      containerStyle={{ backgroundColor: props.background, flex: 1 }}
      childrenContainerStyle={{ backgroundColor: props.background }}
      onSwipeableOpen={(direction) => {
        if (direction !== "right") return;
        swipeableRef.current?.close();
        props.onRemove();
      }}
      renderRightActions={() => (
        <View
          className="items-center justify-center bg-danger"
          style={{ width: REMOVE_ACTION_WIDTH }}
        >
          <SymbolView name="trash" size={16} tintColorClassName="accent-danger-foreground" />
          <Text className="pt-1 text-2xs font-t3-medium text-danger-foreground">Remove</Text>
        </View>
      )}
    >
      {props.children}
    </ReanimatedSwipeable>
  );
}

function QueueAttachmentThumbnails(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}) {
  const images = props.attachments.filter((attachment) => attachment.mimeType.startsWith("image/"));
  const shown = images.slice(0, THUMBNAIL_LIMIT);
  const overflow = props.attachments.length - shown.length;
  if (props.attachments.length === 0) return null;
  return (
    <View className="shrink-0 flex-row items-center gap-1">
      {shown.map((attachment) => (
        <QueueAttachmentThumbnail
          key={attachment.id}
          environmentId={props.environmentId}
          attachment={attachment}
        />
      ))}
      {overflow > 0 ? (
        <View className="h-6 min-w-6 items-center justify-center rounded bg-subtle px-1">
          <Text className="text-2xs tabular-nums text-foreground-muted">
            {shown.length === 0 ? `${overflow}` : `+${overflow}`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function QueueAttachmentThumbnail(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatAttachment;
}) {
  const url = useAssetUrl(props.environmentId, {
    _tag: "attachment",
    attachmentId: props.attachment.id,
    fileName: props.attachment.name,
    mimeType: props.attachment.mimeType,
    disposition: "inline",
  });
  if (url === null) {
    return <View className="h-6 w-6 rounded bg-subtle" />;
  }
  return (
    <Image
      source={{ uri: url }}
      contentFit="cover"
      style={{ width: 24, height: 24, borderRadius: 4 }}
      accessibilityIgnoresInvertColors
    />
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
        className="h-12 w-8 items-center justify-center"
      >
        <SymbolView
          name="line.3.horizontal"
          size={16}
          tintColorClassName="accent-foreground-muted"
        />
      </View>
    </GestureDetector>
  );
}
