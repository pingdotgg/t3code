import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { canSnooze, resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import type { MenuAction } from "@react-native-menu/menu";
import { memo, useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import {
  Alert,
  Platform,
  Pressable,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { useThreadPr } from "../../state/use-thread-pr";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import {
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2Status,
  resolveThreadListV2SwipeActions,
  type ThreadListV2Status,
} from "./threadListV2";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";

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

const SNOOZED_MENU_ACTIONS: MenuAction[] = [
  { id: "unsnooze", title: "Wake thread", image: "clock" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

// Pre-settlement servers: no lifecycle items, archive fills the gap.
const LEGACY_MENU_ACTIONS: MenuAction[] = [
  { id: "archive", title: "Archive", image: "archivebox" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

/** Rounded-row radius shared with the v1 sidebar rows. */
const SIDEBAR_V2_ROW_RADIUS = 12;

/** Section label + rule: the only structure in an otherwise flat list. */
export const ThreadListV2SectionDivider = memo(function ThreadListV2SectionDivider(props: {
  readonly label: string;
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
      <Text className="text-xs font-t3-medium text-foreground-tertiary">{props.label}</Text>
      <View className="h-px flex-1" style={{ backgroundColor: borderColor }} />
    </View>
  );
});

const SNOOZE_ACCENT_LIGHT = "#2563eb";
const SNOOZE_ACCENT_DARK = "#60a5fa";

export const ThreadListV2SnoozedShelfHeader = memo(function ThreadListV2SnoozedShelfHeader(props: {
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
}) {
  const colorScheme = useColorScheme();
  return (
    <Pressable
      accessibilityHint={
        props.expanded ? "Collapses the snoozed threads." : "Expands the snoozed threads."
      }
      accessibilityLabel={props.count === 1 ? "1 snoozed thread" : `${props.count} snoozed threads`}
      accessibilityRole="button"
      accessibilityState={{ expanded: props.expanded }}
      className={cn(
        "mb-1.5 mt-4 flex-row items-center gap-2.5",
        props.pane === "sidebar" ? "px-3" : "px-5",
      )}
      onPress={props.onToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text className="text-xs font-t3-medium text-blue-600 dark:text-blue-400">
        {props.expanded ? "Snoozed" : `Snoozed (${props.count})`}
      </Text>
      <View className="h-px flex-1 bg-blue-500/20 dark:bg-blue-400/15" />
      <SymbolView
        name={props.expanded ? "chevron.up" : "chevron.down"}
        size={10}
        tintColor={colorScheme === "dark" ? SNOOZE_ACCENT_DARK : SNOOZE_ACCENT_LIGHT}
        type="monochrome"
      />
    </Pressable>
  );
});

export const ThreadListV2SettledShelfHeader = memo(function ThreadListV2SettledShelfHeader(props: {
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
}) {
  const mutedColor = useThemeColor("--color-foreground-muted");
  return (
    <Pressable
      accessibilityHint={
        props.expanded ? "Collapses the settled threads." : "Expands the settled threads."
      }
      accessibilityLabel={props.count === 1 ? "1 settled thread" : `${props.count} settled threads`}
      accessibilityRole="button"
      accessibilityState={{ expanded: props.expanded }}
      className={cn(
        "mb-1.5 mt-4 flex-row items-center gap-2.5",
        props.pane === "sidebar" ? "px-3" : "px-5",
      )}
      onPress={props.onToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text className="text-xs font-t3-medium text-foreground-tertiary">
        {props.expanded ? "Settled" : `Settled (${props.count})`}
      </Text>
      <View className="h-px flex-1 bg-border" />
      <SymbolView
        name={props.expanded ? "chevron.up" : "chevron.down"}
        size={10}
        tintColor={mutedColor}
        type="monochrome"
      />
    </Pressable>
  );
});

const PENDING_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

/**
 * A queued new task, in the same idiom as an active v2 row: it is work the
 * user wrote, so it reads like the threads it will become. "Queued" takes
 * the status slot — the state is the one thing that differs — and stays
 * uncolored because nothing is asked of the user; the environment is simply
 * not reachable yet.
 */
export const ThreadListV2PendingRow = memo(function ThreadListV2PendingRow(props: {
  readonly pendingTask: PendingNewTask;
  readonly project: EnvironmentProject | null;
  readonly projectTitle?: string;
  readonly environmentLabel: string | null;
  readonly pane?: "screen" | "sidebar";
  /** Draws the "Pending" divider above the first queued row. */
  readonly showPendingDivider: boolean;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
}) {
  const { pendingTask, onSelectPendingTask, onDeletePendingTask } = props;
  const drawerColor = useThemeColor("--color-drawer");
  const pressedBackgroundColor = useThemeColor("--color-subtle");
  const sidebarPane = props.pane === "sidebar";
  const projectTitle =
    props.projectTitle ?? props.project?.title ?? pendingTask.creation.projectTitle ?? "";
  const branch = pendingTask.creation.branch;

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "delete") onDeletePendingTask(pendingTask);
    },
    [onDeletePendingTask, pendingTask],
  );

  const rowContent = (
    <>
      <View className="flex-row items-center gap-1.5">
        {props.project ? (
          <ProjectFavicon
            environmentId={pendingTask.message.environmentId}
            size={15}
            projectTitle={projectTitle}
            workspaceRoot={props.project.workspaceRoot}
          />
        ) : null}
        <Text className="flex-1 text-sm font-t3-medium text-foreground-muted" numberOfLines={1}>
          {projectTitle}
        </Text>
        <Text className="text-xs text-foreground-tertiary">Queued</Text>
      </View>
      {/* One line, unlike the two an active row allows: a queued title is
          derived from the whole prompt rather than written as a title, so the
          second line is usually a stray word or emoji rather than meaning. */}
      <Text className="mt-1 text-base font-t3-medium text-foreground" numberOfLines={1}>
        {pendingTask.title}
      </Text>
      {branch || props.environmentLabel ? (
        <Text className="mt-1 text-xs text-foreground-muted" numberOfLines={1}>
          {branch ? (
            <Text className="text-xs text-foreground-muted" style={{ fontFamily: MONO_FONT }}>
              {branch}
            </Text>
          ) : null}
          {branch && props.environmentLabel ? "  ·  " : null}
          {props.environmentLabel ? (
            <Text className="text-xs text-foreground-tertiary">{props.environmentLabel}</Text>
          ) : null}
        </Text>
      ) : null}
    </>
  );

  return (
    <>
      {props.showPendingDivider ? (
        <ThreadListV2SectionDivider label="Pending" pane={props.pane} />
      ) : null}
      <ControlPillMenu
        actions={PENDING_TASK_MENU_ACTIONS}
        onPressAction={handleMenuAction}
        shouldOpenOnLongPress
      >
        <Pressable
          accessibilityHint="Opens the queued task for editing"
          accessibilityLabel={pendingTask.title}
          accessibilityRole="button"
          onPress={() => onSelectPendingTask(pendingTask)}
          style={
            sidebarPane
              ? ({ pressed }) => ({
                  backgroundColor: pressed ? pressedBackgroundColor : drawerColor,
                  borderRadius: SIDEBAR_V2_ROW_RADIUS,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                })
              : ({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })
          }
        >
          {sidebarPane ? (
            rowContent
          ) : (
            <View className="bg-screen">
              <View className="px-5 py-2.5">{rowContent}</View>
              <View className="ml-5 h-px bg-border-subtle" />
            </View>
          )}
        </Pressable>
      </ControlPillMenu>
    </>
  );
});

export const ThreadListV2Row = memo(function ThreadListV2Row(props: {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  /** Snoozed-shelf row: shows its wake time and offers Wake. */
  readonly snoozed?: boolean;
  /** Preformatted against the parent minute tick so this memoized row's
      countdown keeps moving. */
  readonly snoozeWakeLabelText?: string;
  /** Parent minute tick passed as a prop so this memoized row refreshes its
      native snooze menu while mounted. */
  readonly snoozePresetMinute: string;
  readonly project: EnvironmentProject | null;
  readonly projectTitle?: string;
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
  readonly onSnoozeThread: (thread: EnvironmentThreadShell, snoozedUntil: string) => void;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  /** False on environments whose server predates thread.settle/unsettle:
      swipe + menu fall back to Archive instead of failing on use. */
  readonly settlementSupported: boolean;
  /** False on servers that predate thread.snooze/unsnooze. */
  readonly snoozeSupported: boolean;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  /** Reports this row's live PR state up so the partition can auto-settle
      merged/closed work (mirrors web's onChangeRequestState). */
  readonly onChangeRequestState?: (
    threadKey: string,
    state: "open" | "closed" | "merged" | null,
  ) => void;
  readonly projectCwd?: string | null;
  readonly searchMatch?: EnvironmentThreadSearchMatch;
  readonly searchQuery?: string;
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
    onSnoozeThread,
    onUnsnoozeThread,
    onUnsettleThread,
    onArchiveThread,
    onChangeRequestState,
  } = props;
  const snoozedRow = props.snoozed === true;

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
  const handleSnooze = useCallback(
    (snoozedUntil: string) => onSnoozeThread(thread, snoozedUntil),
    [onSnoozeThread, thread],
  );
  const handleUnsnooze = useCallback(() => onUnsnoozeThread(thread), [onUnsnoozeThread, thread]);
  const handleUnsettle = useCallback(() => onUnsettleThread(thread), [onUnsettleThread, thread]);
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);

  // Swipe: the v2 primary action is the lifecycle transition. Every settled
  // row can un-settle — explicit settles clear the override, auto-settled
  // rows get pinned active until real activity clears the pin.
  const canUnsettle = variant === "slim";
  const [snoozeGateTick, bumpSnoozeGateTick] = useState(0);
  const snoozeGateExpiryMs = props.snoozeSupported
    ? resolveThreadListV2SnoozeGateExpiryMs(thread, { now: new Date().toISOString() })
    : null;
  useEffect(() => {
    if (snoozeGateExpiryMs === null) return;
    const delayMs = Math.min(Math.max(0, snoozeGateExpiryMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeGateTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
  }, [snoozeGateExpiryMs, snoozeGateTick]);
  const swipeActions = resolveThreadListV2SwipeActions({
    variant,
    settlementSupported: props.settlementSupported,
    snoozeSupported: props.snoozeSupported,
    snoozable: canSnooze(thread, { now: new Date().toISOString() }),
    snoozed: snoozedRow,
  });
  const snoozePresets = useMemo(
    () => (swipeActions.secondary === "snooze" ? resolveSnoozePresets(new Date()) : ([] as const)),
    [props.snoozePresetMinute, swipeActions.secondary],
  );
  const snoozePresetActions = useMemo<MenuAction[]>(
    () =>
      snoozePresets.map((preset) => ({
        id: `snooze:${preset.id}`,
        title: preset.label,
        subtitle: preset.whenLabel,
      })),
    [snoozePresets],
  );
  const snoozableCardMenuActions = useMemo<MenuAction[]>(
    () => [
      { id: "settle", title: "Settle", image: "checkmark" },
      {
        id: "snooze",
        title: "Snooze",
        image: "clock",
        subactions: snoozePresetActions,
      },
      { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
    ],
    [snoozePresetActions],
  );
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "settle") handleSettle();
      if (nativeEvent.event === "unsettle") handleUnsettle();
      if (nativeEvent.event === "unsnooze") handleUnsnooze();
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "delete") handleDelete();
      const snoozeSelection = resolveThreadListV2SnoozeMenuSelection({
        event: nativeEvent.event,
        displayedPresets: snoozePresets,
        now: new Date(),
      });
      if (snoozeSelection._tag === "selected") {
        handleSnooze(snoozeSelection.preset.snoozedUntil);
      } else if (snoozeSelection._tag === "expired") {
        Alert.alert("Could not snooze thread", "That snooze time has passed. Choose another time.");
      }
    },
    [
      handleArchive,
      handleDelete,
      handleSettle,
      handleSnooze,
      handleUnsettle,
      handleUnsnooze,
      snoozePresets,
    ],
  );
  const primaryAction = useMemo(() => {
    // Pre-settlement server: archive is the swipe action, as in v1. (Slim
    // rows cannot occur here — unsupported environments never classify as
    // settled.)
    if (swipeActions.primary === "archive") {
      return {
        accessibilityLabel: `Archive ${thread.title}`,
        icon: "archivebox" as const,
        label: "Archive",
        onPress: handleArchive,
      };
    }
    if (swipeActions.primary === "unsnooze") {
      return {
        accessibilityLabel: `Wake ${thread.title} now`,
        icon: "clock" as const,
        label: "Wake",
        onPress: handleUnsnooze,
      };
    }
    return swipeActions.primary === "unsettle"
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
    handleArchive,
    handleSettle,
    handleUnsettle,
    handleUnsnooze,
    swipeActions.primary,
    thread.title,
  ]);
  const secondaryAction = useMemo(
    () =>
      swipeActions.secondary === "snooze"
        ? {
            accessibilityLabel: `Choose when to snooze ${thread.title}`,
            icon: "clock" as const,
            label: "Snooze",
            menu: {
              actions: snoozePresetActions,
              onPressAction: handleMenuAction,
              title: "Snooze until",
            },
            onPress: () => undefined,
          }
        : null,
    [handleMenuAction, snoozePresetActions, swipeActions.secondary, thread.title],
  );
  const swipeAccessibilityHint =
    secondaryAction === null
      ? `Opens the thread. Swipe left to ${primaryAction.label.toLowerCase()}.`
      : `Opens the thread. Swipe left for ${primaryAction.label.toLowerCase()} and snooze actions.`;

  // The sidebar pane fills selected rows with the accent color (matching the
  // v1 sidebar), so every piece of row text needs a white-on-accent variant.
  const cardContent = (
    <>
      <View className="flex-row items-center gap-1.5">
        {props.project ? (
          <ProjectFavicon
            environmentId={thread.environmentId}
            size={15}
            projectTitle={props.projectTitle ?? props.project.title}
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
          {props.projectTitle ?? props.project?.title ?? ""}
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
      {props.searchMatch ? (
        <View className="mt-1">
          <ThreadSearchMatchExcerpt
            match={props.searchMatch}
            query={props.searchQuery ?? ""}
            selected={selected}
          />
        </View>
      ) : null}
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
        accessibilityHint={swipeAccessibilityHint}
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
        accessibilityHint={swipeAccessibilityHint}
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
                projectTitle={props.projectTitle ?? props.project.title}
                workspaceRoot={props.project.workspaceRoot}
              />
            </View>
          ) : null}
          <View className="min-w-0 flex-1">
            <Text
              className={cn(
                "text-base",
                selected ? "text-user-bubble-foreground" : "text-foreground-muted",
              )}
              numberOfLines={1}
            >
              {thread.title}
            </Text>
            {props.searchMatch ? (
              <ThreadSearchMatchExcerpt
                match={props.searchMatch}
                query={props.searchQuery ?? ""}
                selected={selected}
              />
            ) : null}
          </View>
          <Text
            className={cn(
              "text-sm tabular-nums",
              selected
                ? "text-user-bubble-foreground-muted"
                : snoozedRow
                  ? "text-blue-600 dark:text-blue-400"
                  : "text-foreground-tertiary",
            )}
            style={{ fontFamily: MONO_FONT }}
          >
            {snoozedRow && props.snoozeWakeLabelText !== undefined
              ? props.snoozeWakeLabelText
              : relativeTime(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt)}
          </Text>
        </View>
      </Pressable>
    );

  return (
    <>
      <ThreadSwipeable
        backgroundColor={sidebarPane ? drawerColor : screenColor}
        compactActions={variant === "slim"}
        containerStyle={
          sidebarPane ? { borderRadius: SIDEBAR_V2_ROW_RADIUS, overflow: "hidden" } : undefined
        }
        enableTrackpadSwipe
        // Full swipe commits the advertised lifecycle action (Settle /
        // Un-settle), never the secondary snooze action.
        fullSwipeAction="primary"
        fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
        onDelete={handleDelete}
        onSwipeableClose={props.onSwipeableClose}
        onSwipeableWillOpen={props.onSwipeableWillOpen}
        primaryAction={primaryAction}
        secondaryAction={secondaryAction}
        resetKey={`${thread.environmentId}:${thread.id}`}
        simultaneousWithExternalGesture={props.simultaneousSwipeGesture}
        threadTitle={thread.title}
      >
        {(close) => (
          <ControlPillMenu
            actions={
              snoozedRow
                ? SNOOZED_MENU_ACTIONS
                : !props.settlementSupported
                  ? LEGACY_MENU_ACTIONS
                  : canUnsettle
                    ? SLIM_MENU_ACTIONS
                    : swipeActions.secondary === "snooze"
                      ? snoozableCardMenuActions
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
