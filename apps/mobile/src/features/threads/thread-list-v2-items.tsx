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
 * Thread List v2 renders one flat native list: rich edge-to-edge rows for
 * active work and a receded settled tail, all with native swipe and
 * long-press actions. State reads through colored status labels and text
 * hierarchy rather than card fills.
 */

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

// Status hues follow the system-wide convention set by sidebar v1 and the
// Live Activity/widgets (amber approval, indigo input, sky working) so a
// thread reads the same color everywhere it surfaces.
const STATUS_LABEL_BY_STATUS: Partial<
  Record<ThreadListV2Status, { label: string; className: string }>
> = {
  approval: { label: "Approval", className: "text-amber-700 dark:text-amber-300" },
  input: { label: "Input", className: "text-indigo-600 dark:text-indigo-300" },
  working: { label: "Working", className: "text-sky-600 dark:text-sky-400" },
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

/** Rounded-row radius shared with the v1 sidebar rows. */
const SIDEBAR_V2_ROW_RADIUS = 12;

export const ThreadListV2SettledDivider = memo(function ThreadListV2SettledDivider(props: {
  readonly pane?: "screen" | "sidebar";
}) {
  const borderColor = useThemeColor("--color-border");
  return (
    <View
      className={cn(
        "mb-1.5 mt-4 flex-row items-center gap-2.5",
        props.pane === "sidebar" ? "px-3" : "px-5",
      )}
    >
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
  /** Which machine hosts the thread. Null when only one environment is
      connected — repeating the same label on every row is noise. Mirrors
      the web sidebar's remote-environment cloud icon, but as text since
      phones have no hover tooltips. */
  readonly environmentLabel: string | null;
  /** Hosting surface. "screen" (default) renders the compact Home idiom:
      flat edge-to-edge rows on the screen background with inset hairlines.
      "sidebar" renders the iPad split-view idiom: rounded rows blending
      into the drawer surface, selection filled with the accent color —
      matching the v1 sidebar rows. */
  readonly pane?: "screen" | "sidebar";
  /** Highlights the thread open in the detail pane (iPad split view). The
      compact Home list never sets it — phones navigate away on select. */
  readonly selected?: boolean;
  /** Override for narrow panes (iPad sidebar); defaults to window width. */
  readonly fullSwipeWidth?: number;
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
  const drawerColor = useThemeColor("--color-drawer");
  const pressedBackgroundColor = useThemeColor("--color-subtle");
  const selectedBackgroundColor = useThemeColor("--color-user-bubble");
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected === true;

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

  // The sidebar pane fills selected rows with the accent color (matching the
  // v1 sidebar), so every piece of row text needs a white-on-accent variant.
  const cardContent = (
    <>
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
          className={cn(
            "flex-1 text-sm font-t3-medium",
            selected ? "text-user-bubble-foreground-muted" : "text-foreground-muted",
          )}
          numberOfLines={1}
        >
          {props.project?.title ?? ""}
        </Text>
        <Text
          className={cn(
            "text-xs tabular-nums",
            selected ? "text-white" : (statusLabel?.className ?? "text-foreground-tertiary"),
          )}
        >
          {statusLabel?.label ?? timeLabel}
        </Text>
      </View>
      <Text
        className={cn(
          "mt-1 text-base font-t3-medium",
          selected ? "text-user-bubble-foreground" : "text-foreground",
        )}
        numberOfLines={2}
      >
        {thread.title}
      </Text>
      <View className="mt-1 flex-row items-center gap-2">
        {status === "failed" && thread.session?.lastError ? (
          <Text
            className={cn(
              "flex-1 text-xs",
              selected
                ? "text-user-bubble-foreground-muted"
                : "text-red-600/80 dark:text-red-400/80",
            )}
            numberOfLines={1}
          >
            {thread.session.lastError}
          </Text>
        ) : thread.branch || props.environmentLabel ? (
          /* "branch · machine" share one truncating line. The machine sits
             last so a tight fit cuts the repetitive label, not the branch —
             and machine-only fills the row for non-git projects. */
          <Text
            className={cn(
              "flex-1 text-xs",
              selected ? "text-user-bubble-foreground-muted" : "text-foreground-muted",
            )}
            numberOfLines={1}
          >
            {thread.branch ? (
              <Text
                className={cn(
                  "text-xs",
                  selected ? "text-user-bubble-foreground-muted" : "text-foreground-muted",
                )}
                style={{ fontFamily: MONO_FONT }}
              >
                {thread.branch}
              </Text>
            ) : null}
            {thread.branch && props.environmentLabel ? "  ·  " : null}
            {props.environmentLabel ? (
              <Text
                className={cn(
                  "text-xs",
                  selected ? "text-user-bubble-foreground-muted" : "text-foreground-tertiary",
                )}
              >
                {props.environmentLabel}
              </Text>
            ) : null}
          </Text>
        ) : (
          <View className="flex-1" />
        )}
        {pr ? (
          <Text
            accessibilityLabel={pr.accessibilityLabel}
            className={cn("text-xs", selected ? "text-white" : pr.textClassName)}
            style={{ fontFamily: MONO_FONT }}
          >
            #{pr.label}
          </Text>
        ) : null}
        {props.providerDriver ? (
          <View className="opacity-60">
            <ProviderIcon provider={props.providerDriver} size={14} />
          </View>
        ) : null}
      </View>
    </>
  );

  const rowContent = (close: () => void) =>
    variant === "card" ? (
      <Pressable
        accessibilityHint={`Opens the thread. Swipe left to ${primaryAction.label.toLowerCase()}.`}
        accessibilityLabel={thread.title}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
        style={
          sidebarPane
            ? ({ pressed }) => ({
                backgroundColor: selected
                  ? selectedBackgroundColor
                  : pressed
                    ? pressedBackgroundColor
                    : drawerColor,
                borderRadius: SIDEBAR_V2_ROW_RADIUS,
                paddingHorizontal: 12,
                paddingVertical: 10,
              })
            : ({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })
        }
      >
        {sidebarPane ? (
          cardContent
        ) : (
          /* Flat native list rows: no tonal containers — colored status
             labels and text hierarchy carry state, an inset hairline
             separates rows. The opaque screen background stays so swipe
             actions reveal behind the row. */
          <View className="bg-screen">
            <View className="px-5 py-2.5">{cardContent}</View>
            <View className="ml-5 h-px bg-border-subtle" />
          </View>
        )}
      </Pressable>
    ) : (
      <Pressable
        accessibilityHint={`Opens the thread. Swipe left to ${primaryAction.label.toLowerCase()}.`}
        accessibilityLabel={thread.title}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        className={sidebarPane ? undefined : "bg-screen"}
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
        style={
          sidebarPane
            ? ({ pressed }) => ({
                backgroundColor: selected
                  ? selectedBackgroundColor
                  : pressed
                    ? pressedBackgroundColor
                    : drawerColor,
                borderRadius: SIDEBAR_V2_ROW_RADIUS,
              })
            : ({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })
        }
      >
        {/* Settled history recedes: dimmed favicon + muted title. */}
        <View
          className={cn(
            "min-h-[44px] flex-row items-center gap-2.5 py-2",
            sidebarPane ? "px-3" : "px-5",
          )}
        >
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
          <Text
            className={cn(
              "flex-1 text-base",
              selected ? "text-user-bubble-foreground" : "text-foreground-muted",
            )}
            numberOfLines={1}
          >
            {thread.title}
          </Text>
          <Text
            className={cn(
              "text-sm tabular-nums",
              selected ? "text-user-bubble-foreground-muted" : "text-foreground-tertiary",
            )}
            style={{ fontFamily: MONO_FONT }}
          >
            {relativeTime(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt)}
          </Text>
        </View>
      </Pressable>
    );

  return (
    <>
      {props.showSettledDivider ? <ThreadListV2SettledDivider pane={props.pane} /> : null}
      <ThreadSwipeable
        backgroundColor={sidebarPane ? drawerColor : screenColor}
        compactActions={variant === "slim"}
        containerStyle={
          sidebarPane ? { borderRadius: SIDEBAR_V2_ROW_RADIUS, overflow: "hidden" } : undefined
        }
        enableTrackpadSwipe
        // Full swipe commits the advertised lifecycle action (Settle /
        // Un-settle), never the destructive delete.
        fullSwipeAction="primary"
        fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
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
