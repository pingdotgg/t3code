import { useRecyclingState } from "@legendapp/list/react-native";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { MenuAction } from "@react-native-menu/menu";
import { SymbolView } from "expo-symbols";
import { memo, useCallback, useMemo, type ComponentProps } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { relativeTime } from "../../lib/time";
import { resolveThreadListPrimaryAction } from "../../lib/threadInbox";
import { useThemeColor } from "../../lib/useThemeColor";
import { SceneryImage } from "../scenery/SceneryImage";
import { useSceneryPhoto, useThreadDisplayNames } from "../scenery/use-scenery";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { useThreadPr } from "../../state/use-thread-pr";
import { useThreadHealth } from "../../state/use-thread-health";
import type { HomeGroupDisplayAction } from "../home/homeListItems";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { resolveThreadStatus } from "./threadPresentation";

/**
 * Shared presentation for the thread lists: the compact (phone) Home list and
 * the iPad sidebar render the SAME items — group headers with collapse,
 * thread rows with status/PR/subtitle, and show-more rows — differing only in
 * metrics and chrome via `variant`.
 */
export type ThreadListVariant = "compact" | "sidebar";

/** Left inset that aligns compact secondary rows with the title column. */
export const THREAD_LIST_COMPACT_INSET = 20;
const SIDEBAR_ROW_RADIUS = 12;

/* ─── Project group header ───────────────────────────────────────────── */

export const ThreadListGroupHeader = memo(function ThreadListGroupHeader(props: {
  readonly variant: ThreadListVariant;
  readonly project: EnvironmentProject;
  readonly title: string;
  readonly threadCount: number;
  readonly collapsed: boolean;
  readonly isFirst: boolean;
  readonly groupKey: string;
  readonly onGroupAction: (key: string, action: HomeGroupDisplayAction) => void;
}) {
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const { groupKey, onGroupAction } = props;
  const compact = props.variant === "compact";
  const handleToggle = useCallback(
    () => onGroupAction(groupKey, "toggle-collapsed"),
    [groupKey, onGroupAction],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: !props.collapsed }}
      accessibilityLabel={`${props.title}, ${props.threadCount} threads`}
      accessibilityHint={props.collapsed ? "Expands the project" : "Collapses the project"}
      className={compact ? "bg-screen" : undefined}
      onPress={handleToggle}
    >
      <View
        className={
          compact
            ? `flex-row items-center gap-2.5 px-5 pb-3 ${props.isFirst ? "pt-2" : "pt-6"}`
            : `flex-row items-center gap-2 px-3 pb-2 ${props.isFirst ? "pt-1" : "pt-5"}`
        }
        style={{ minHeight: compact ? 44 : 36 }}
      >
        <ProjectFavicon
          environmentId={props.project.environmentId}
          size={compact ? 22 : 18}
          projectTitle={props.project.title}
          workspaceRoot={props.project.workspaceRoot}
        />
        <Text
          className={
            compact
              ? "flex-shrink text-base font-t3-bold text-foreground-muted"
              : "flex-shrink text-sm font-t3-bold text-foreground-muted"
          }
          style={{ letterSpacing: 0.2 }}
          numberOfLines={1}
        >
          {props.title}
        </Text>
        <Text
          className={
            compact
              ? "flex-1 text-sm font-t3-medium text-foreground-tertiary"
              : "flex-1 text-xs font-t3-medium text-foreground-tertiary"
          }
        >
          {props.threadCount}
        </Text>
        <SymbolView
          name={props.collapsed ? "chevron.right" : "chevron.down"}
          size={compact ? 13 : 11}
          tintColor={iconSubtleColor}
          type="monochrome"
          weight="semibold"
        />
      </View>
    </Pressable>
  );
});

/* ─── Show more / show less row ──────────────────────────────────────── */

export const ThreadListShowMoreRow = memo(function ThreadListShowMoreRow(props: {
  readonly variant: ThreadListVariant;
  readonly hiddenCount: number;
  readonly canShowLess: boolean;
  readonly groupKey: string;
  readonly onGroupAction: (key: string, action: HomeGroupDisplayAction) => void;
}) {
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const showsMore = props.hiddenCount > 0;
  const compact = props.variant === "compact";
  const { groupKey, onGroupAction } = props;
  const handleShowMore = useCallback(
    () => onGroupAction(groupKey, "show-more"),
    [groupKey, onGroupAction],
  );
  const handleShowLess = useCallback(
    () => onGroupAction(groupKey, "show-less"),
    [groupKey, onGroupAction],
  );

  const button = (label: string, icon: "chevron.down" | "chevron.up", onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label === "Show more" ? "Show more threads" : "Show fewer threads"}
      className="rounded-full bg-subtle"
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => ({
        opacity: pressed ? 0.6 : 1,
        paddingHorizontal: compact ? 14 : 12,
        paddingVertical: compact ? 7 : 6,
        borderCurve: "continuous",
      })}
    >
      <View className="flex-row items-center gap-1.5">
        <SymbolView
          name={icon}
          size={10}
          tintColor={iconSubtleColor}
          type="monochrome"
          weight="semibold"
        />
        <Text
          className={
            compact
              ? "text-sm font-t3-medium text-foreground-muted"
              : "text-xs font-t3-medium text-foreground-muted"
          }
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );

  return (
    <View
      className={
        compact ? "flex-row items-center gap-2.5 bg-screen" : "flex-row items-center gap-2"
      }
      style={{
        paddingLeft: compact ? THREAD_LIST_COMPACT_INSET : 12,
        paddingRight: compact ? 18 : 12,
        paddingVertical: compact ? 12 : 8,
      }}
    >
      {showsMore ? button("Show more", "chevron.down", handleShowMore) : null}
      {props.canShowLess ? button("Show less", "chevron.up", handleShowLess) : null}
    </View>
  );
});

/* ─── Settled disclosure row ─────────────────────────────────────────── */

/**
 * Per-group "Settled" disclosure (mac SidebarView.settledDisclosure parity):
 * settled threads leave the inbox and collapse behind this row; tapping
 * reveals them underneath.
 */
export const ThreadListSettledToggleRow = memo(function ThreadListSettledToggleRow(props: {
  readonly variant: ThreadListVariant;
  readonly settledCount: number;
  readonly revealed: boolean;
  readonly groupKey: string;
  readonly onGroupAction: (key: string, action: HomeGroupDisplayAction) => void;
  /**
   * Archives every settled thread in the group at once. macOS reveals the
   * equivalent button on hover; with no hover on iOS it sits inline and always
   * visible, and confirms before running so the row's own tap target (the
   * disclosure) cannot trigger a bulk archive by accident.
   *
   * Takes the group key rather than the thread batch: the batch is rebuilt on
   * every unrelated thread event, so carrying it here would churn this row's
   * identity, and a memoized row would archive whichever set it last rendered
   * with. The screen resolves the current settled threads on press instead.
   */
  readonly onArchiveSettled?: (groupKey: string) => void;
}) {
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const separatorColor = useThemeColor("--color-separator");
  const compact = props.variant === "compact";
  const { groupKey, onArchiveSettled, onGroupAction } = props;
  const handleToggle = useCallback(
    () => onGroupAction(groupKey, "toggle-settled"),
    [groupKey, onGroupAction],
  );
  const handleArchiveSettled = useCallback(
    () => onArchiveSettled?.(groupKey),
    [groupKey, onArchiveSettled],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: props.revealed }}
      accessibilityLabel={`Settled, ${props.settledCount} threads`}
      accessibilityHint={props.revealed ? "Hides the settled threads" : "Shows the settled threads"}
      className={compact ? "bg-screen" : undefined}
      onPress={handleToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingLeft: compact ? THREAD_LIST_COMPACT_INSET : 12,
          paddingRight: compact ? 18 : 12,
          paddingVertical: compact ? 10 : 8,
          borderTopWidth: 1,
          borderTopColor: separatorColor,
        }}
      >
        <SymbolView
          name="checkmark.circle"
          size={compact ? 13 : 11}
          tintColor={iconSubtleColor}
          type="monochrome"
        />
        <Text
          className={
            compact
              ? "flex-1 text-sm font-t3-medium text-foreground-muted"
              : "flex-1 text-xs font-t3-medium text-foreground-muted"
          }
        >
          Settled
        </Text>
        <Text
          className={
            compact
              ? "text-sm font-t3-medium text-foreground-tertiary"
              : "text-xs font-t3-medium text-foreground-tertiary"
          }
        >
          {props.settledCount}
        </Text>
        {onArchiveSettled && props.settledCount > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Archive all ${props.settledCount} settled threads`}
            hitSlop={8}
            onPress={handleArchiveSettled}
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <SymbolView
              name="archivebox"
              size={compact ? 13 : 11}
              tintColor={iconSubtleColor}
              type="monochrome"
            />
          </Pressable>
        ) : null}
        <SymbolView
          name={props.revealed ? "chevron.down" : "chevron.right"}
          size={compact ? 12 : 10}
          tintColor={iconSubtleColor}
          type="monochrome"
          weight="semibold"
        />
      </View>
    </Pressable>
  );
});

/* ─── Pending task row ───────────────────────────────────────────────── */

const PENDING_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

/**
 * Wash seed for a queued task: the same scoped key its thread will get once
 * delivered, so the pending row's gradient matches the eventual thread row.
 */
function pendingTaskSceneSeed(pendingTask: PendingNewTask): string {
  return scopedThreadKey(pendingTask.message.environmentId, pendingTask.message.threadId);
}

/**
 * A queued new task waiting in the outbox for its environment to reconnect.
 * Tapping reopens the new-task composer with everything prefilled; the row
 * disappears once the task is delivered and the real thread arrives.
 */
export const PendingTaskListRow = memo(function PendingTaskListRow(props: {
  readonly variant: ThreadListVariant;
  readonly pendingTask: PendingNewTask;
  readonly environmentLabel: string | null;
  readonly isLast: boolean;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
}) {
  const compact = props.variant === "compact";
  const separatorColor = useThemeColor("--color-separator");
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const foregroundColor = useThemeColor("--color-foreground");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const pressedBackgroundColor = useThemeColor("--color-subtle");
  const scenePhoto = useSceneryPhoto(pendingTaskSceneSeed(props.pendingTask));

  const { pendingTask, onSelectPendingTask, onDeletePendingTask } = props;
  const timestamp = relativeTime(pendingTask.message.createdAt);
  const subtitleParts = [props.environmentLabel, pendingTask.creation.branch].filter(
    (part): part is string => Boolean(part),
  );

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "delete") onDeletePendingTask(pendingTask);
    },
    [onDeletePendingTask, pendingTask],
  );

  const statusPill = (
    <View
      className="bg-zinc-500/12 dark:bg-zinc-500/16"
      style={{ borderRadius: 99, paddingHorizontal: 6, paddingVertical: 2 }}
    >
      <Text className="text-3xs font-t3-bold text-zinc-600 dark:text-zinc-300">Pending</Text>
    </View>
  );

  const subtitleRow =
    subtitleParts.length > 0 ? (
      <View className="flex-row items-center gap-1.5" style={{ marginTop: 1 }}>
        <SymbolView
          name="tray.and.arrow.up"
          size={10}
          tintColor={compact ? iconSubtleColor : mutedColor}
          type="monochrome"
        />
        <Text
          className={compact ? "text-sm text-foreground-muted" : "text-xs"}
          numberOfLines={1}
          style={compact ? { flexShrink: 1 } : { flexShrink: 1, color: mutedColor }}
        >
          {subtitleParts.join(" · ")}
        </Text>
      </View>
    ) : null;

  const rowContent = compact ? (
    <Pressable
      accessibilityHint="Opens the queued task for editing"
      accessibilityLabel={pendingTask.title}
      accessibilityRole="button"
      className="bg-screen"
      onPress={() => onSelectPendingTask(pendingTask)}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          paddingLeft: THREAD_LIST_COMPACT_INSET,
          paddingRight: 18,
          paddingTop: 10,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            borderBottomWidth: props.isLast ? 0 : 1,
            borderBottomColor: separatorColor,
            paddingBottom: 10,
          }}
        >
          <SceneryImage
            fallbackSeed={pendingTaskSceneSeed(pendingTask)}
            photo={scenePhoto}
            style={{ width: 36, height: 36, borderRadius: 10 }}
            variant="thumb"
          />
          <View style={{ flex: 1, gap: 3 }}>
            <View className="flex-row items-center justify-between gap-2">
              <Text className="flex-1 text-lg font-t3-bold text-foreground" numberOfLines={1}>
                {pendingTask.title}
              </Text>
              <View className="flex-row items-center gap-2">
                {statusPill}
                <Text
                  className="text-base text-foreground-tertiary"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {timestamp}
                </Text>
                <SymbolView
                  name="chevron.right"
                  size={13}
                  tintColor={iconSubtleColor}
                  type="monochrome"
                />
              </View>
            </View>
            {subtitleRow}
          </View>
        </View>
      </View>
    </Pressable>
  ) : (
    <Pressable
      accessibilityHint="Opens the queued task for editing"
      accessibilityLabel={pendingTask.title}
      accessibilityRole="button"
      onPress={() => onSelectPendingTask(pendingTask)}
      style={({ pressed }) => ({
        backgroundColor: pressed ? pressedBackgroundColor : "transparent",
        borderRadius: SIDEBAR_ROW_RADIUS,
        cursor: "pointer",
        minHeight: 64,
        justifyContent: "center",
        paddingHorizontal: 12,
        paddingVertical: 10,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <SceneryImage
          fallbackSeed={pendingTaskSceneSeed(pendingTask)}
          photo={scenePhoto}
          style={{ width: 36, height: 36, borderRadius: 10 }}
          variant="thumb"
        />
        <View style={{ flex: 1, gap: 3 }}>
          <View className="flex-row items-center justify-between gap-2">
            <Text
              className="flex-1 text-base font-t3-medium"
              numberOfLines={1}
              style={{ color: foregroundColor }}
            >
              {pendingTask.title}
            </Text>
            <View className="flex-row items-center gap-2">
              {statusPill}
              <Text
                className="text-xs"
                numberOfLines={1}
                style={{ color: mutedColor, fontVariant: ["tabular-nums"] }}
              >
                {timestamp}
              </Text>
            </View>
          </View>
          {subtitleRow}
        </View>
      </View>
    </Pressable>
  );

  return (
    <ControlPillMenu
      actions={PENDING_TASK_MENU_ACTIONS}
      onPressAction={handleMenuAction}
      shouldOpenOnLongPress
    >
      {rowContent}
    </ControlPillMenu>
  );
});

/* ─── Thread row ─────────────────────────────────────────────────────── */

const THREAD_ROW_MENU_ARCHIVE_ACTION: MenuAction = {
  id: "archive",
  title: "Archive",
  image: "archivebox",
};
const THREAD_ROW_MENU_DELETE_ACTION: MenuAction = {
  id: "delete",
  title: "Delete",
  image: "trash",
  attributes: { destructive: true },
};

export const ThreadListRow = memo(function ThreadListRow(props: {
  readonly variant: ThreadListVariant;
  readonly thread: EnvironmentThreadShell;
  readonly environmentLabel: string | null;
  readonly projectCwd: string | null;
  readonly isLast: boolean;
  /** Sidebar only: the thread currently open in the detail pane. */
  readonly selected?: boolean;
  /** Defaults to window width minus compact margins. */
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread?: (thread: EnvironmentThreadShell) => void;
  readonly onUnsettleThread?: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly simultaneousSwipeGesture?: ComponentProps<
    typeof ThreadSwipeable
  >["simultaneousWithExternalGesture"];
}) {
  const { width: windowWidth } = useWindowDimensions();
  const compact = props.variant === "compact";
  const selected = props.selected === true;
  // Recycling-safe: resets when the list container is reused for another
  // thread, so a hover highlight can't leak across rows.
  const [hovered, setHovered] = useRecyclingState(false);

  const separatorColor = useThemeColor("--color-separator");
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const screenColor = useThemeColor("--color-screen");
  const drawerColor = useThemeColor("--color-drawer");
  const foregroundColor = useThemeColor("--color-foreground");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const pressedBackgroundColor = useThemeColor("--color-subtle");
  const selectedBackgroundColor = useThemeColor("--color-user-bubble");
  const selectedForegroundColor = useThemeColor("--color-user-bubble-foreground");
  const selectedMutedColor = useThemeColor("--color-user-bubble-foreground-muted");

  const {
    thread,
    onSelectThread,
    onArchiveThread,
    onSettleThread,
    onUnsettleThread,
    onDeleteThread,
  } = props;
  const threadKey = scopedThreadKey(thread.environmentId, thread.id);
  const scenePhoto = useSceneryPhoto(threadKey);
  // Two-line scene naming (mac parity): primary is the stable scene place
  // name, description is the server-generated title once it has replaced the
  // scene seed. Falls back to `{ primary: thread.title, description: null }`
  // when the thread has no resolvable scene, so the row renders exactly as
  // before (title only).
  const names = useThreadDisplayNames(threadKey, thread.title);
  const baseStatus = resolveThreadStatus(thread);
  const health = useThreadHealth(
    baseStatus?.kind === "working" ||
      baseStatus?.kind === "fixing" ||
      baseStatus?.kind === "reviewing"
      ? { environmentId: thread.environmentId, threadId: thread.id }
      : null,
  );
  const status = health?.stalled ? resolveThreadStatus(thread, health) : baseStatus;
  // Mirrors what the row actually renders (scene name, plus the
  // server-generated description once titled), not the raw thread.title the
  // row no longer displays on its own.
  const rowAccessibilityLabel = [
    names.description !== null ? `${names.primary}, ${names.description}` : names.primary,
    status?.kind === "stalled" ? "Stalled — no recent activity" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  const pr = useThreadPr(thread, props.projectCwd);
  const timestamp = relativeTime(
    thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
  );
  const subtitleParts = [props.environmentLabel, thread.branch].filter((part): part is string =>
    Boolean(part),
  );

  const backgroundColor = compact ? screenColor : drawerColor;
  const effectiveForeground = selected ? selectedForegroundColor : foregroundColor;
  const effectiveMuted = selected ? selectedMutedColor : mutedColor;
  const effectivePressedBackground = selected ? "rgba(255,255,255,0.16)" : pressedBackgroundColor;
  const effectiveStatus =
    selected && status
      ? { ...status, pillClassName: "bg-white/20", textClassName: "text-white" }
      : status;

  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);
  const handleSettle = useCallback(() => onSettleThread?.(thread), [onSettleThread, thread]);
  const handleUnsettle = useCallback(() => onUnsettleThread?.(thread), [onUnsettleThread, thread]);
  // Swipe primary by lifecycle state (mac context-menu parity): settled rows
  // offer "Mark as Active", settleable active rows offer "Settle", and rows
  // the inbox semantics refuse to settle (running, pending approval/input)
  // keep "Archive".
  const primaryActionKind = resolveThreadListPrimaryAction(thread);
  const primaryAction = useMemo(() => {
    if (primaryActionKind === "unsettle" && onUnsettleThread) {
      return {
        accessibilityLabel: `Mark ${thread.title} as active`,
        icon: "arrow.counterclockwise" as const,
        label: "Unsettle",
        onPress: handleUnsettle,
      };
    }
    if (primaryActionKind === "settle" && onSettleThread) {
      return {
        accessibilityLabel: `Settle ${thread.title}`,
        icon: "checkmark.circle" as const,
        label: "Settle",
        onPress: handleSettle,
      };
    }
    return {
      accessibilityLabel: `Archive ${thread.title}`,
      icon: "archivebox" as const,
      label: "Archive",
      onPress: handleArchive,
    };
  }, [
    handleArchive,
    handleSettle,
    handleUnsettle,
    onSettleThread,
    onUnsettleThread,
    primaryActionKind,
    thread.title,
  ]);
  const menuActions = useMemo<MenuAction[]>(() => {
    const actions: MenuAction[] = [];
    if (primaryActionKind === "unsettle" && onUnsettleThread) {
      actions.push({
        id: "unsettle",
        title: "Mark as Active",
        image: "arrow.counterclockwise",
      });
    } else if (onSettleThread) {
      actions.push({
        id: "settle",
        title: "Settle Thread",
        image: "checkmark.circle",
        attributes: primaryActionKind === "settle" ? undefined : { disabled: true },
      });
    }
    actions.push(THREAD_ROW_MENU_ARCHIVE_ACTION, THREAD_ROW_MENU_DELETE_ACTION);
    return actions;
  }, [onSettleThread, onUnsettleThread, primaryActionKind]);
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "settle") handleSettle();
      if (nativeEvent.event === "unsettle") handleUnsettle();
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "delete") handleDelete();
    },
    [handleArchive, handleDelete, handleSettle, handleUnsettle],
  );

  const statusPill = effectiveStatus ? (
    <View
      accessibilityLabel={
        effectiveStatus.kind === "stalled" ? "Stalled — no recent activity" : undefined
      }
      className={effectiveStatus.pillClassName}
      style={{ borderRadius: 99, paddingHorizontal: 6, paddingVertical: 2 }}
    >
      <Text className={`text-3xs font-t3-bold ${effectiveStatus.textClassName}`}>
        {effectiveStatus.label}
      </Text>
    </View>
  ) : null;

  const subtitleRow =
    subtitleParts.length > 0 || pr !== null ? (
      <View className="flex-row items-center gap-1.5" style={{ marginTop: 1 }}>
        {subtitleParts.length > 0 ? (
          <>
            <SymbolView
              name="arrow.triangle.branch"
              size={10}
              tintColor={compact ? iconSubtleColor : effectiveMuted}
              type="monochrome"
            />
            <Text
              className={compact ? "text-sm text-foreground-muted" : "text-xs"}
              numberOfLines={1}
              style={compact ? { flexShrink: 1 } : { flexShrink: 1, color: effectiveMuted }}
            >
              {subtitleParts.join(" · ")}
            </Text>
          </>
        ) : null}
        {pr !== null ? (
          <Text
            className={`${compact ? "text-sm" : "text-xs"} font-t3-medium ${
              selected ? "text-white" : pr.textClassName
            }`}
          >
            {pr.label}
          </Text>
        ) : null}
      </View>
    ) : null;

  // Server-generated title, once first-turn titling has replaced the scene
  // seed — the mac sidebar's "description" line, directly under the scene
  // name.
  const descriptionRow =
    names.description !== null ? (
      <Text
        className={compact ? "text-sm text-foreground-muted" : "text-xs"}
        numberOfLines={1}
        style={compact ? { marginTop: 1 } : { marginTop: 1, color: effectiveMuted }}
      >
        {names.description}
      </Text>
    ) : null;

  const rowContent = (close: () => void) =>
    compact ? (
      <Pressable
        accessibilityHint="Swipe left for archive and delete actions"
        accessibilityLabel={rowAccessibilityLabel}
        accessibilityRole="button"
        className="bg-screen"
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        <View
          style={{
            paddingLeft: THREAD_LIST_COMPACT_INSET,
            paddingRight: 18,
            paddingTop: 10,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              borderBottomWidth: props.isLast ? 0 : 1,
              borderBottomColor: separatorColor,
              paddingBottom: 10,
            }}
          >
            <SceneryImage
              fallbackSeed={threadKey}
              photo={scenePhoto}
              style={{ width: 36, height: 36, borderRadius: 10 }}
              variant="thumb"
            />
            <View style={{ flex: 1, gap: 3 }}>
              <View className="flex-row items-center justify-between gap-2">
                <Text className="flex-1 text-lg font-t3-bold text-foreground" numberOfLines={1}>
                  {names.primary}
                </Text>
                <View className="flex-row items-center gap-2">
                  {statusPill}
                  <Text
                    className="text-base text-foreground-tertiary"
                    style={{ fontVariant: ["tabular-nums"] }}
                  >
                    {timestamp}
                  </Text>
                  <SymbolView
                    name="chevron.right"
                    size={13}
                    tintColor={iconSubtleColor}
                    type="monochrome"
                  />
                </View>
              </View>
              {descriptionRow}
              {subtitleRow}
            </View>
          </View>
        </View>
      </Pressable>
    ) : (
      <Pressable
        accessibilityHint="Opens the thread"
        accessibilityLabel={rowAccessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
        style={({ pressed }) => ({
          backgroundColor: selected
            ? selectedBackgroundColor
            : pressed || hovered
              ? effectivePressedBackground
              : backgroundColor,
          borderRadius: SIDEBAR_ROW_RADIUS,
          cursor: "pointer",
          minHeight: 64,
          justifyContent: "center",
          paddingHorizontal: 12,
          paddingVertical: 10,
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <SceneryImage
            fallbackSeed={threadKey}
            photo={scenePhoto}
            style={{ width: 36, height: 36, borderRadius: 10 }}
            variant="thumb"
          />
          <View style={{ flex: 1, gap: 3 }}>
            <View className="flex-row items-center justify-between gap-2">
              <Text
                className="flex-1 text-base font-t3-medium"
                numberOfLines={1}
                style={{ color: effectiveForeground }}
              >
                {names.primary}
              </Text>
              <View className="flex-row items-center gap-2">
                {statusPill}
                <Text
                  className="text-xs"
                  numberOfLines={1}
                  style={{ color: effectiveMuted, fontVariant: ["tabular-nums"] }}
                >
                  {timestamp}
                </Text>
              </View>
            </View>
            {descriptionRow}
            {subtitleRow}
          </View>
        </View>
      </Pressable>
    );

  return (
    <ThreadSwipeable
      backgroundColor={backgroundColor}
      containerStyle={
        compact ? undefined : { borderRadius: SIDEBAR_ROW_RADIUS, overflow: "hidden" }
      }
      enableTrackpadSwipe
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
        // Messages-style row actions: a real UIContextMenuInteraction on
        // long-press / pointer right-click, with the row as the zoom preview.
        // Requires the patched @react-native-menu (see
        // patches/@react-native-menu__menu@2.0.0.patch): in long-press mode
        // the interaction is hosted by the component view and the underlying
        // UIButton passes touches through, so row taps keep working.
        <ControlPillMenu
          actions={menuActions}
          onPressAction={handleMenuAction}
          shouldOpenOnLongPress
        >
          {rowContent(close)}
        </ControlPillMenu>
      )}
    </ThreadSwipeable>
  );
});
