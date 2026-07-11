import { useRecyclingState } from "@legendapp/list/react-native";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { MenuAction } from "@react-native-menu/menu";
import { SymbolView } from "../../components/AppSymbol";
import { memo, useCallback, useMemo, type ComponentProps } from "react";
import { Pressable, useColorScheme, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import Svg, { Circle, Path } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { useThreadPr, type ThreadPr } from "../../state/use-thread-pr";
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

function pullRequestTintColor(
  state: ThreadPr["state"],
  colorScheme: ReturnType<typeof useColorScheme>,
) {
  const dark = colorScheme === "dark";
  switch (state) {
    case "open":
      return dark ? "#34d399" : "#059669";
    case "merged":
      return dark ? "#a78bfa" : "#7c3aed";
    case "closed":
      return dark ? "#a1a1aa" : "#71717a";
  }
}

function PullRequestIcon(props: { readonly size: number; readonly color: string }) {
  return (
    <Svg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={props.color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Circle cx={18} cy={18} r={3} />
      <Circle cx={6} cy={6} r={3} />
      <Path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <Path d="M6 9v12" />
    </Svg>
  );
}

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
  /** Project a quick new thread should target; null hides the button. */
  readonly newThreadTarget?: EnvironmentProject | null;
  readonly onNewThread?: (project: EnvironmentProject) => void;
}) {
  const iconMutedColor = useThemeColor("--color-icon-muted");
  const { groupKey, onGroupAction, onNewThread } = props;
  const newThreadTarget = props.newThreadTarget ?? null;
  const compact = props.variant === "compact";
  const handleToggle = useCallback(
    () => onGroupAction(groupKey, "toggle-collapsed"),
    [groupKey, onGroupAction],
  );
  const handleNewThread = useCallback(() => {
    if (newThreadTarget) {
      onNewThread?.(newThreadTarget);
    }
  }, [newThreadTarget, onNewThread]);
  const showNewThreadButton = onNewThread !== undefined && newThreadTarget !== null;

  // The new-thread button is a SIBLING of the collapse toggle, not a child:
  // nested touchables are unreachable to VoiceOver/TalkBack (the parent
  // swallows focus). Row padding lives on the container (explicit styles —
  // dynamic padding classes on Pressable did not apply reliably) so both
  // children share one centerline; hitSlop restores the padded tap area.
  const verticalHitSlop = { top: props.isFirst ? 8 : 24, bottom: 12 };
  return (
    <View
      className={compact ? "flex-row items-center bg-screen" : "flex-row items-center"}
      style={{
        minHeight: compact ? 44 : 36,
        paddingLeft: compact ? 20 : 12,
        // Compact right padding centers the 20pt plus glyph on the thread
        // rows' trailing chevron column (18 + 13/2 ≈ 24.5 from the edge).
        paddingRight: compact ? 14 : 12,
        paddingBottom: compact ? 12 : 8,
        paddingTop: props.isFirst ? (compact ? 8 : 4) : compact ? 24 : 20,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !props.collapsed }}
        accessibilityLabel={`${props.title}, ${props.threadCount} threads`}
        accessibilityHint={props.collapsed ? "Expands the project" : "Collapses the project"}
        className={
          compact ? "flex-1 flex-row items-center gap-2.5" : "flex-1 flex-row items-center gap-2"
        }
        hitSlop={{ ...verticalHitSlop, left: compact ? 20 : 12 }}
        onPress={handleToggle}
      >
        <ProjectFavicon
          environmentId={props.project.environmentId}
          open={!props.collapsed}
          size={compact ? 22 : 18}
          projectTitle={props.project.title}
          workspaceRoot={props.project.workspaceRoot}
        />
        <Text
          className={
            compact
              ? "flex-shrink text-base font-t3-bold tracking-[0.2px] text-foreground-muted"
              : "flex-shrink text-sm font-t3-bold tracking-[0.2px] text-foreground-muted"
          }
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
      </Pressable>
      {showNewThreadButton ? (
        <Pressable
          accessibilityLabel={`Create new thread in ${props.title}`}
          accessibilityRole="button"
          hitSlop={{ ...verticalHitSlop, left: 10, right: 14 }}
          onPress={handleNewThread}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, paddingLeft: 12 })}
        >
          <SymbolView
            name="plus"
            size={compact ? 20 : 16}
            tintColor={iconMutedColor}
            type="monochrome"
            weight="medium"
          />
        </Pressable>
      ) : null}
    </View>
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

/* ─── Pending task row ───────────────────────────────────────────────── */

const PENDING_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

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
  const mutedColor = useThemeColor("--color-foreground-muted");
  const pressedBackgroundColor = useThemeColor("--color-subtle");

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
    <View className="rounded-full bg-zinc-500/12 px-1.5 py-0.5 dark:bg-zinc-500/16">
      <Text className="text-3xs font-t3-bold text-zinc-600 dark:text-zinc-300">Pending</Text>
    </View>
  );

  const subtitleRow =
    subtitleParts.length > 0 ? (
      <View className="mt-px flex-row items-center gap-1.5">
        <SymbolView
          name="tray.and.arrow.up"
          size={10}
          tintColor={compact ? iconSubtleColor : mutedColor}
          type="monochrome"
        />
        <Text
          className={
            compact
              ? "shrink text-sm text-foreground-muted"
              : "shrink text-xs text-foreground-muted"
          }
          numberOfLines={1}
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
            gap: 3,
            borderBottomWidth: props.isLast ? 0 : 1,
            borderBottomColor: separatorColor,
            paddingBottom: 10,
          }}
        >
          <View className="flex-row items-center justify-between gap-2">
            <Text className="flex-1 text-lg font-t3-bold text-foreground" numberOfLines={1}>
              {pendingTask.title}
            </Text>
            <View className="flex-row items-center gap-2">
              {statusPill}
              <Text className="text-base tabular-nums text-foreground-tertiary">{timestamp}</Text>
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
      <View className="gap-[3px]">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="flex-1 text-base font-t3-medium text-foreground" numberOfLines={1}>
            {pendingTask.title}
          </Text>
          <View className="flex-row items-center gap-2">
            {statusPill}
            <Text className="text-xs tabular-nums text-foreground-muted" numberOfLines={1}>
              {timestamp}
            </Text>
          </View>
        </View>
        {subtitleRow}
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

const THREAD_ROW_MENU_ACTIONS: MenuAction[] = [
  { id: "archive", title: "Archive", image: "archivebox" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

export const ThreadListRow = memo(function ThreadListRow(props: {
  readonly variant: ThreadListVariant;
  readonly thread: EnvironmentThreadShell;
  readonly environmentLabel: string | null;
  readonly projectCwd: string | null;
  readonly isLast: boolean;
  readonly depth?: number;
  readonly hasSubagentChildren?: boolean;
  readonly isSubagentBranchExpanded?: boolean;
  readonly subagentTreeVisible?: boolean;
  readonly hasUnavailableSubagentParent?: boolean;
  readonly onToggleSubagentBranch?: (thread: EnvironmentThreadShell) => void;
  /** Sidebar only: the thread currently open in the detail pane. */
  readonly selected?: boolean;
  /** Defaults to window width minus compact margins. */
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly simultaneousSwipeGesture?: ComponentProps<
    typeof ThreadSwipeable
  >["simultaneousWithExternalGesture"];
}) {
  const { width: windowWidth } = useWindowDimensions();
  const colorScheme = useColorScheme();
  const compact = props.variant === "compact";
  const selected = props.selected === true;
  // Recycling-safe: resets when the list container is reused for another
  // thread, so a hover highlight can't leak across rows.
  const [hovered, setHovered] = useRecyclingState(false);

  const separatorColor = useThemeColor("--color-separator");
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const screenColor = useThemeColor("--color-screen");
  const drawerColor = useThemeColor("--color-drawer");
  const pressedBackgroundColor = useThemeColor("--color-subtle");
  const selectedBackgroundColor = useThemeColor("--color-user-bubble");

  const { thread, onSelectThread, onArchiveThread, onDeleteThread } = props;
  const status = resolveThreadStatus(thread);
  const pr = useThreadPr(thread, props.projectCwd);
  const timestamp = relativeTime(
    thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
  );
  const unavailableParentLabel = props.hasUnavailableSubagentParent ? "Parent unavailable" : null;
  const threadAccessibilityLabel = [thread.title, unavailableParentLabel, pr?.accessibilityLabel]
    .filter((part): part is string => Boolean(part))
    .join(", ");
  const subtitleParts = [props.environmentLabel, thread.branch, unavailableParentLabel].filter(
    (part): part is string => Boolean(part),
  );

  const backgroundColor = compact ? screenColor : drawerColor;
  const effectivePressedBackground = selected ? "rgba(255,255,255,0.16)" : pressedBackgroundColor;
  const effectiveStatus =
    selected && status
      ? { ...status, pillClassName: "bg-white/20", textClassName: "text-white" }
      : status;

  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);
  const primaryAction = useMemo(
    () => ({
      accessibilityLabel: `Archive ${thread.title}`,
      icon: "archivebox" as const,
      label: "Archive",
      onPress: handleArchive,
    }),
    [handleArchive, thread.title],
  );
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "delete") handleDelete();
    },
    [handleArchive, handleDelete],
  );

  const statusPill = effectiveStatus ? (
    <View className={`${effectiveStatus.pillClassName} rounded-full px-1.5 py-0.5`}>
      <Text className={`text-3xs font-t3-bold ${effectiveStatus.textClassName}`}>
        {effectiveStatus.label}
      </Text>
    </View>
  ) : null;

  const subtitleRow =
    subtitleParts.length > 0 || pr !== null ? (
      <View className="mt-px flex-row items-center gap-1.5">
        {subtitleParts.length > 0 ? (
          <>
            <Text
              className={cn(
                "shrink",
                compact ? "text-sm text-foreground-muted" : "text-xs",
                !compact &&
                  (selected ? "text-user-bubble-foreground-muted" : "text-foreground-muted"),
              )}
              numberOfLines={1}
            >
              {subtitleParts.join(" · ")}
            </Text>
          </>
        ) : null}
        {pr !== null ? (
          <View className="flex-row items-center gap-0.5">
            <PullRequestIcon
              size={compact ? 13 : 11}
              color={selected ? "#ffffff" : pullRequestTintColor(pr.state, colorScheme)}
            />
            <Text
              className={`${compact ? "text-sm" : "text-xs"} font-t3-medium ${
                selected ? "text-white" : pr.textClassName
              }`}
            >
              {pr.label}
            </Text>
          </View>
        ) : null}
      </View>
    ) : null;

  const rowButton = (close: () => void) =>
    compact ? (
      <Pressable
        accessibilityHint="Swipe left for archive and delete actions"
        accessibilityLabel={threadAccessibilityLabel}
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
              gap: 3,
              borderBottomWidth: props.isLast ? 0 : 1,
              borderBottomColor: separatorColor,
              paddingBottom: 10,
            }}
          >
            <View className="flex-row items-center justify-between gap-2">
              <Text className="flex-1 text-lg font-t3-bold text-foreground" numberOfLines={1}>
                {thread.title}
              </Text>
              <View className="flex-row items-center gap-2">
                {statusPill}
                <Text className="text-base tabular-nums text-foreground-tertiary">{timestamp}</Text>
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
      </Pressable>
    ) : (
      <Pressable
        accessibilityHint="Opens the thread"
        accessibilityLabel={threadAccessibilityLabel}
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
        <View className="gap-[3px]">
          <View className="flex-row items-center justify-between gap-2">
            <Text
              className={cn(
                "flex-1 text-base font-t3-medium",
                selected ? "text-user-bubble-foreground" : "text-foreground",
              )}
              numberOfLines={1}
            >
              {thread.title}
            </Text>
            <View className="flex-row items-center gap-2">
              {statusPill}
              <Text
                className={cn(
                  "text-xs tabular-nums",
                  selected ? "text-user-bubble-foreground-muted" : "text-foreground-muted",
                )}
                numberOfLines={1}
              >
                {timestamp}
              </Text>
            </View>
          </View>
          {subtitleRow}
        </View>
      </Pressable>
    );

  const rowContent = (close: () => void) => {
    const treeVisible = props.subagentTreeVisible === true;
    const hasChildren = props.hasSubagentChildren === true;
    const expanded = props.isSubagentBranchExpanded === true;
    const depth = props.depth ?? 0;
    const disclosureSize = compact ? 28 : 24;
    const disclosure = treeVisible ? (
      hasChildren ? (
        <Pressable
          accessibilityLabel={`${expanded ? "Collapse" : "Expand"} subagents for ${thread.title}`}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          hitSlop={6}
          onPress={() => {
            close();
            props.onToggleSubagentBranch?.(thread);
          }}
          style={({ pressed }) => ({
            alignItems: "center",
            alignSelf: "stretch",
            justifyContent: "center",
            opacity: pressed ? 0.5 : 1,
            width: disclosureSize,
          })}
        >
          <SymbolView
            name={expanded ? "chevron.down" : "chevron.right"}
            size={compact ? 12 : 10}
            tintColor={selected ? "#ffffff" : iconSubtleColor}
            type="monochrome"
            weight="semibold"
          />
        </Pressable>
      ) : (
        <View style={{ width: disclosureSize }} />
      )
    ) : null;

    return (
      <View
        style={{
          backgroundColor: treeVisible && selected ? selectedBackgroundColor : backgroundColor,
          flexDirection: "row",
          paddingLeft: treeVisible ? depth * (compact ? 16 : 14) : 0,
        }}
      >
        {disclosure}
        <View style={{ flex: 1 }}>
          {/* Keep the disclosure and row as sibling controls so both remain
              reachable to VoiceOver/TalkBack. */}
          <ControlPillMenu
            actions={THREAD_ROW_MENU_ACTIONS}
            onPressAction={handleMenuAction}
            shouldOpenOnLongPress
            style={{ flex: 1 }}
          >
            {rowButton(close)}
          </ControlPillMenu>
        </View>
      </View>
    );
  };

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
      {(close) => rowContent(close)}
    </ThreadSwipeable>
  );
});
