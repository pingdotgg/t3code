import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { MenuAction } from "@react-native-menu/menu";
import { memo, useCallback, useEffect, useMemo, type ComponentProps } from "react";
import { Platform, Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadPr } from "../../state/use-thread-pr";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { resolveThreadListV2Status, type ThreadListV2Status } from "./threadListV2";

/**
 * Thread List v2 rows mirror the web sidebar's compact tonal cards and
 * receded settled tail while retaining native swipe and long-press actions.
 */

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

const STATUS_LABEL_BY_STATUS: Partial<
  Record<ThreadListV2Status, { label: string; className: string }>
> = {
  approval: { label: "Approval", className: "text-amber-700 dark:text-amber-300" },
  input: { label: "Input", className: "text-amber-700 dark:text-amber-300" },
  working: { label: "Working", className: "text-blue-600 dark:text-blue-400" },
  failed: { label: "Failed", className: "text-red-700 dark:text-red-300" },
};

function threadTimeLabel(thread: EnvironmentThreadShell): string {
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

export const ThreadListV2SettledDivider = memo(function ThreadListV2SettledDivider() {
  const borderColor = useThemeColor("--color-border");
  return (
    <View className="mb-1.5 mt-4 flex-row items-center gap-2.5 px-5">
      <Text className="text-xs font-t3-medium text-foreground-tertiary">Settled</Text>
      <View className="h-px flex-1" style={{ backgroundColor: borderColor }} />
    </View>
  );
});

export const ThreadListV2Row = memo(function ThreadListV2Row(props: {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  readonly showSettledDivider: boolean;
  readonly project: EnvironmentProject | null;
  readonly providerDriver: string | null;
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

  const screenColor = useThemeColor("--color-screen");

  const status = resolveThreadListV2Status(thread);
  const statusLabel = STATUS_LABEL_BY_STATUS[status];
  const timeLabel = threadTimeLabel(thread);

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
      <Pressable
        accessibilityHint={`Opens the thread. Swipe left to ${primaryAction.label.toLowerCase()}.`}
        accessibilityLabel={thread.title}
        accessibilityRole="button"
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        <View className="bg-screen px-4 py-1">
          <View
            className={cn(
              "overflow-hidden",
              status === "ready"
                ? "bg-black/[0.025] dark:bg-white/[0.025]"
                : "bg-black/[0.04] dark:bg-white/[0.04]",
            )}
            style={{ borderRadius: 12, borderCurve: "continuous", minHeight: 84 }}
          >
            <View className="px-3 py-2.5">
              <View className="flex-row items-center gap-1.5">
                {props.project ? (
                  <ProjectFavicon
                    environmentId={thread.environmentId}
                    size={15}
                    projectTitle={props.project.title}
                    workspaceRoot={props.project.workspaceRoot}
                  />
                ) : null}
                <Text
                  className="flex-1 text-sm font-t3-medium text-foreground-muted"
                  numberOfLines={1}
                >
                  {props.project?.title ?? ""}
                </Text>
                <Text
                  className={cn(
                    "text-xs tabular-nums",
                    statusLabel?.className ?? "text-foreground-tertiary",
                  )}
                >
                  {statusLabel?.label ?? timeLabel}
                </Text>
              </View>
              <Text className="mt-1 text-base font-t3-medium text-foreground" numberOfLines={2}>
                {thread.title}
              </Text>
              <View className="mt-1 flex-row items-center gap-2">
                {status === "failed" && thread.session?.lastError ? (
                  <Text
                    className="flex-1 text-xs text-red-600/80 dark:text-red-400/80"
                    numberOfLines={1}
                  >
                    {thread.session.lastError}
                  </Text>
                ) : thread.branch ? (
                  <Text
                    className="flex-1 text-xs text-foreground-muted"
                    numberOfLines={1}
                    style={{ fontFamily: MONO_FONT }}
                  >
                    {thread.branch}
                  </Text>
                ) : (
                  <View className="flex-1" />
                )}
                {props.providerDriver ? (
                  <View className="opacity-60">
                    <ProviderIcon provider={props.providerDriver} size={14} />
                  </View>
                ) : null}
              </View>
            </View>
          </View>
        </View>
      </Pressable>
    ) : (
      <Pressable
        accessibilityHint={`Opens the thread. Swipe left to ${primaryAction.label.toLowerCase()}.`}
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
        <View className="min-h-[44px] flex-row items-center gap-2.5 px-5 py-2">
          {props.project ? (
            <View className="opacity-40">
              <ProjectFavicon
                environmentId={thread.environmentId}
                size={15}
                projectTitle={props.project.title}
                workspaceRoot={props.project.workspaceRoot}
              />
            </View>
          ) : null}
          <Text className="flex-1 text-base text-foreground-muted" numberOfLines={1}>
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
