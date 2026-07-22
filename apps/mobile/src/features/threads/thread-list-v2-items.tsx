import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { MenuAction } from "@react-native-menu/menu";
import { memo, useCallback, useMemo, type ComponentProps, type ReactNode } from "react";
import { Platform, Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadPr } from "../../state/use-thread-pr";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { resolveThreadListV2Status, type ThreadListV2Status } from "./threadListV2";
import { useEffect } from "react";

/**
 * Thread List v2 rows. The design language is the web sidebar v2 (status
 * edge strip, mono project labels, settled tail), but the card anatomy is
 * native iOS list-app, not the web's window chrome: a solid raised surface
 * (no outline), a leading favicon tile as the touch anchor, a trailing
 * chevron, and spring press feedback. Bordered translucent boxes with a
 * header row read as notifications — information, not buttons.
 */

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

const EDGE_CLASS_BY_STATUS: Partial<Record<ThreadListV2Status, string>> = {
  approval: "bg-amber-500 dark:bg-amber-400",
  input: "bg-amber-500 dark:bg-amber-400",
  working: "bg-sky-500 dark:bg-sky-400",
  failed: "bg-red-500",
};

const STATUS_WORD_BY_STATUS: Partial<
  Record<ThreadListV2Status, { label: string; className: string }>
> = {
  approval: { label: "NEEDS APPROVAL", className: "text-amber-600 dark:text-amber-400" },
  input: { label: "AWAITING INPUT", className: "text-amber-600 dark:text-amber-400" },
  working: { label: "WORKING", className: "text-sky-600 dark:text-sky-400" },
  failed: { label: "FAILED", className: "text-red-600 dark:text-red-400" },
};

function threadTimeLabel(thread: EnvironmentThreadShell, status: ThreadListV2Status): string {
  if (status === "approval" || status === "input") {
    return `waiting ${relativeTime(thread.updatedAt)}`;
  }
  return relativeTime(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt);
}

// Menus stay lifecycle-focused: settle/un-settle plus delete. Archive keeps
// its own surface (thread screen / settings) rather than crowding the row.
const CARD_MENU_ACTIONS: MenuAction[] = [
  { id: "settle", title: "Settle", image: "checkmark" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const SLIM_MENU_ACTIONS: MenuAction[] = [
  { id: "unsettle", title: "Un-settle", image: "arrow.uturn.backward" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

// Pre-settlement servers: no lifecycle items, archive fills the gap.
const LEGACY_MENU_ACTIONS: MenuAction[] = [
  { id: "archive", title: "Archive", image: "archivebox" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const PRESS_SPRING = { damping: 30, stiffness: 400 } as const;

/**
 * Pressable that springs down to 97% while touched — the "this is a real
 * object under your finger" signal every native list app ships.
 *
 * Accepts an injected `onLongPress` and forwards it to the inner Pressable:
 * on Android, ControlPillMenu opens its menu by cloning its immediate child
 * with an onLongPress prop, so this component must be that child and must
 * route the handler to something that actually handles presses.
 */
function PressableScaleCard(props: {
  readonly accessibilityHint: string;
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  readonly onLongPress?: () => void;
  readonly children: ReactNode;
}) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        accessibilityHint={props.accessibilityHint}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="button"
        onPress={props.onPress}
        {...(props.onLongPress ? { onLongPress: props.onLongPress } : {})}
        onPressIn={() => {
          scale.value = withSpring(0.97, PRESS_SPRING);
        }}
        onPressOut={() => {
          scale.value = withSpring(1, PRESS_SPRING);
        }}
      >
        {props.children}
      </Pressable>
    </Animated.View>
  );
}

export const ThreadListV2SettledDivider = memo(function ThreadListV2SettledDivider() {
  const separatorColor = useThemeColor("--color-separator");
  return (
    <View className="mb-2 mt-4 flex-row items-center gap-2.5 px-5">
      <Text
        className="text-2xs font-t3-bold uppercase text-foreground-tertiary"
        style={{ fontFamily: MONO_FONT, letterSpacing: 1.8 }}
      >
        Settled
      </Text>
      <View className="h-px flex-1" style={{ backgroundColor: separatorColor }} />
    </View>
  );
});

export const ThreadListV2Row = memo(function ThreadListV2Row(props: {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  readonly showSettledDivider: boolean;
  readonly project: EnvironmentProject | null;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  /** False on environments whose server predates thread.settle/unsettle:
      swipe + menu fall back to Archive instead of failing on use. */
  readonly settlementSupported: boolean;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  /** Reports this row's live PR state up so the partition can auto-settle
      merged/closed work (mirrors web's onChangeRequestState). */
  readonly onChangeRequestState?: (
    threadKey: string,
    state: "open" | "closed" | "merged" | null,
  ) => void;
  readonly projectCwd?: string | null;
  readonly simultaneousSwipeGesture?: ComponentProps<
    typeof ThreadSwipeable
  >["simultaneousWithExternalGesture"];
}) {
  const { width: windowWidth } = useWindowDimensions();
  const {
    thread,
    variant,
    onSelectThread,
    onDeleteThread,
    onSettleThread,
    onUnsettleThread,
    onArchiveThread,
    onChangeRequestState,
  } = props;

  const pr = useThreadPr(thread, props.projectCwd ?? props.project?.workspaceRoot ?? null);
  const prState = pr?.state ?? null;
  const threadKey = `${thread.environmentId}:${thread.id}`;
  useEffect(() => {
    onChangeRequestState?.(threadKey, prState);
  }, [onChangeRequestState, prState, threadKey]);

  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const screenColor = useThemeColor("--color-screen");

  const status = resolveThreadListV2Status(thread);
  const statusEdge = EDGE_CLASS_BY_STATUS[status];
  const statusWord = STATUS_WORD_BY_STATUS[status];
  const timeLabel = threadTimeLabel(thread, status);

  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleSettle = useCallback(() => onSettleThread(thread), [onSettleThread, thread]);
  const handleUnsettle = useCallback(() => onUnsettleThread(thread), [onUnsettleThread, thread]);
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "settle") handleSettle();
      if (nativeEvent.event === "unsettle") handleUnsettle();
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "delete") handleDelete();
    },
    [handleArchive, handleDelete, handleSettle, handleUnsettle],
  );

  // Swipe: the v2 primary action is the lifecycle transition. Every settled
  // row can un-settle — explicit settles clear the override, auto-settled
  // rows get pinned active until real activity clears the pin.
  const canUnsettle = variant === "slim";
  const primaryAction = useMemo(() => {
    // Pre-settlement server: archive is the swipe action, as in v1. (Slim
    // rows cannot occur here — unsupported environments never classify as
    // settled.)
    if (!props.settlementSupported) {
      return {
        accessibilityLabel: `Archive ${thread.title}`,
        icon: "archivebox" as const,
        label: "Archive",
        onPress: handleArchive,
      };
    }
    return canUnsettle
      ? {
          accessibilityLabel: `Un-settle ${thread.title}`,
          icon: "arrow.uturn.backward" as const,
          label: "Un-settle",
          onPress: handleUnsettle,
        }
      : {
          accessibilityLabel: `Settle ${thread.title}`,
          icon: "checkmark" as const,
          label: "Settle",
          onPress: handleSettle,
        };
  }, [
    canUnsettle,
    handleArchive,
    handleSettle,
    handleUnsettle,
    props.settlementSupported,
    thread.title,
  ]);

  const rowContent = (close: () => void) =>
    variant === "card" ? (
      // PressableScaleCard must be the ROOT here: ControlPillMenu injects
      // its Android long-press by cloning this element.
      <PressableScaleCard
        accessibilityHint="Opens the thread. Swipe left to settle."
        accessibilityLabel={thread.title}
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
      >
        <View className="bg-screen px-4 py-1.5">
          {/* Solid raised card: bg-card with no border reads as an object,
              not a notification banner. */}
          <View
            className="flex-row items-center overflow-hidden bg-card"
            style={{ borderRadius: 18, borderCurve: "continuous", minHeight: 84 }}
          >
            {statusEdge ? <View className={cn("h-full w-1", statusEdge)} /> : null}
            {/* Favicon tile: the leading touch anchor, app-icon style. */}
            <View
              className="ml-3 mr-3 items-center justify-center bg-subtle"
              style={{ width: 38, height: 38, borderRadius: 10, borderCurve: "continuous" }}
            >
              {props.project ? (
                <ProjectFavicon
                  environmentId={thread.environmentId}
                  size={22}
                  projectTitle={props.project.title}
                  workspaceRoot={props.project.workspaceRoot}
                />
              ) : null}
            </View>
            <View className="flex-1 py-3 pr-2">
              <View className="flex-row items-center gap-2">
                <Text
                  className="flex-1 text-2xs font-t3-bold uppercase text-foreground-tertiary"
                  numberOfLines={1}
                  style={{ fontFamily: MONO_FONT, letterSpacing: 1.2 }}
                >
                  {props.project?.title ?? ""}
                </Text>
                <Text
                  className={cn(
                    "text-2xs tabular-nums",
                    status === "approval"
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-foreground-tertiary",
                  )}
                  style={{ fontFamily: MONO_FONT }}
                >
                  {timeLabel}
                </Text>
              </View>
              <Text className="mt-0.5 text-lg font-t3-bold text-foreground" numberOfLines={2}>
                {thread.title}
              </Text>
              {statusWord || thread.branch || (status === "failed" && thread.session?.lastError) ? (
                <View className="mt-0.5 flex-row items-center gap-2">
                  {statusWord ? (
                    <Text
                      className={cn("text-sm font-t3-bold", statusWord.className)}
                      style={{ fontFamily: MONO_FONT, letterSpacing: 0.7 }}
                    >
                      {statusWord.label}
                    </Text>
                  ) : null}
                  {status === "failed" && thread.session?.lastError ? (
                    <Text
                      className="flex-1 text-sm text-red-600/80 dark:text-red-400/80"
                      numberOfLines={1}
                    >
                      {thread.session.lastError}
                    </Text>
                  ) : thread.branch ? (
                    <Text
                      className="flex-1 text-sm text-foreground-muted"
                      numberOfLines={1}
                      style={{ fontFamily: MONO_FONT }}
                    >
                      {thread.branch}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </View>
            {/* Trailing chevron: the universal "this navigates" affordance. */}
            <View className="pr-3.5">
              <SymbolView
                name="chevron.right"
                size={14}
                tintColor={iconSubtleColor}
                type="monochrome"
                weight="semibold"
              />
            </View>
          </View>
        </View>
      </PressableScaleCard>
    ) : (
      <Pressable
        accessibilityHint={`Opens the thread. Swipe left to ${canUnsettle ? "un-settle" : "settle"}.`}
        accessibilityLabel={thread.title}
        accessibilityRole="button"
        className="bg-screen"
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        {/* Settled history recedes: dimmed favicon + muted title. */}
        <View className="min-h-[48px] flex-row items-center gap-3 px-5 py-2.5">
          {props.project ? (
            <View className="opacity-40">
              <ProjectFavicon
                environmentId={thread.environmentId}
                size={18}
                projectTitle={props.project.title}
                workspaceRoot={props.project.workspaceRoot}
              />
            </View>
          ) : null}
          <Text className="flex-1 text-lg text-foreground-muted" numberOfLines={1}>
            {thread.title}
          </Text>
          <Text
            className="text-sm tabular-nums text-foreground-tertiary"
            style={{ fontFamily: MONO_FONT }}
          >
            {relativeTime(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt)}
          </Text>
        </View>
      </Pressable>
    );

  return (
    <>
      {props.showSettledDivider ? <ThreadListV2SettledDivider /> : null}
      <ThreadSwipeable
        backgroundColor={screenColor}
        enableTrackpadSwipe
        // Full swipe commits the advertised lifecycle action (Settle /
        // Un-settle), never the destructive delete.
        fullSwipeAction="primary"
        fullSwipeWidth={windowWidth - 32}
        onDelete={handleDelete}
        onSwipeableClose={props.onSwipeableClose}
        onSwipeableWillOpen={props.onSwipeableWillOpen}
        primaryAction={primaryAction}
        resetKey={`${thread.environmentId}:${thread.id}`}
        simultaneousWithExternalGesture={props.simultaneousSwipeGesture}
        threadTitle={thread.title}
      >
        {(close) => (
          <ControlPillMenu
            actions={
              !props.settlementSupported
                ? LEGACY_MENU_ACTIONS
                : canUnsettle
                  ? SLIM_MENU_ACTIONS
                  : CARD_MENU_ACTIONS
            }
            onPressAction={handleMenuAction}
            shouldOpenOnLongPress
          >
            {rowContent(close)}
          </ControlPillMenu>
        )}
      </ThreadSwipeable>
    </>
  );
});
