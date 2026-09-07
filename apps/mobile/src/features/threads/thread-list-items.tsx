import { useRecyclingState } from "@legendapp/list/react-native";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { SymbolView } from "../../components/AppSymbol";
import { memo, useCallback, useMemo, type ComponentProps } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import Svg, { Circle, Path } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { cn } from "../../lib/cn";
import { HOME_HORIZONTAL_INSET } from "../../lib/layoutMetrics";
import { relativeTime } from "../../lib/time";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { useThreadPr, type ThreadPrPresentation } from "../../state/use-thread-pr";
import type { HomeGroupDisplayAction } from "../home/homeListItems";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import { QueuedMessageIcon } from "./queued-message-icon";
import { resolveThreadStatus } from "./threadPresentation";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";

/**
 * Shared presentation for the thread lists: the compact (phone) Home list and
 * the iPad sidebar render the SAME items — group headers with collapse,
 * thread rows with status/PR/subtitle, and show-more rows — differing only in
 * metrics and chrome via `variant`.
 */
export type ThreadListVariant = "compact" | "sidebar";

/** Left inset that aligns compact secondary rows with the title column. */
export const THREAD_LIST_COMPACT_INSET = HOME_HORIZONTAL_INSET;
const SIDEBAR_ROW_RADIUS = 12;

function pullRequestTintColor(
  pr: Pick<ThreadPrPresentation, "state" | "isDraft">,
  colorScheme: "light" | "dark",
) {
  const dark = colorScheme === "dark";
  if (pr.state === "open" && pr.isDraft === true) {
    return dark ? "#a1a1aa" : "#71717a";
  }
  switch (pr.state) {
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
          faviconPath={props.project.faviconPath}
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
            tintColorClassName={"accent-icon-muted"}
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
          tintColorClassName={"accent-icon-subtle"}
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

const DRAFT_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Discard", image: "trash", attributes: { destructive: true } },
];

/**
 * Unsent work: a task queued in the outbox for its environment to reconnect,
 * or a draft still sitting in the project's new-task composer. Tapping
 * reopens the composer with everything prefilled; the row disappears once
 * the work is sent and the real thread arrives. The two kinds differ in what
 * happens next, so the pill and icon say which one this is: a queued task
 * sends itself, a draft waits for the user.
 */
export const PendingTaskListRow = memo(function PendingTaskListRow(props: {
  readonly variant: ThreadListVariant;
  readonly pendingTask: PendingNewTask;
  readonly environmentLabel: string | null;
  readonly environmentMachine?: EnvironmentMachineKind;
  readonly isLast: boolean;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
}) {
  const compact = props.variant === "compact";

  const { pendingTask, onSelectPendingTask, onDeletePendingTask } = props;
  const isDraft = pendingTask.kind === "draft";
  const timestamp = isDraft ? null : relativeTime(pendingTask.createdAt);
  // The pill only has room for one word, so what happens next goes in the
  // subtitle: a queued task sends itself, a draft waits for the user.
  const subtitleParts = [
    isDraft ? null : "Sends on reconnect",
    props.environmentLabel,
    pendingTask.branch,
  ].filter((part): part is string => Boolean(part));

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "delete") onDeletePendingTask(pendingTask);
    },
    [onDeletePendingTask, pendingTask],
  );

  const statusPill = isDraft ? (
    <View className="rounded-full bg-adaptive-amber-500-a12-a16 px-1.5 py-0.5">
      <Text className="text-3xs font-t3-bold text-adaptive-amber-700-300">Draft</Text>
    </View>
  ) : (
    <View className="rounded-full bg-subtle px-1.5 py-0.5">
      <Text className="text-3xs font-t3-bold text-foreground-muted">Pending</Text>
    </View>
  );

  const subtitleRow =
    subtitleParts.length > 0 ? (
      <View className="mt-px flex-row items-center gap-1.5">
        <SymbolView
          name={isDraft ? "square.and.pencil" : "tray.and.arrow.up"}
          size={10}
          tintColorClassName={compact ? "accent-icon-subtle" : "accent-foreground-muted"}
          type="monochrome"
        />
        {props.environmentLabel && props.environmentMachine ? (
          <EnvironmentMachineSymbol
            kind={props.environmentMachine}
            size={compact ? 12 : 10}
            tintColorClassName={compact ? "accent-icon-subtle" : "accent-foreground-muted"}
          />
        ) : null}
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

  const accessibilityHint = isDraft
    ? "Opens the draft in the new task composer"
    : "Sends when the environment reconnects. Opens the task for editing";

  const rowContent = compact ? (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={pendingTask.title}
      accessibilityRole="button"
      className="bg-screen active:opacity-70"
      onPress={() => onSelectPendingTask(pendingTask)}
    >
      <View className="pr-[18px] pt-[10px]" style={{ paddingLeft: THREAD_LIST_COMPACT_INSET }}>
        <View className={cn("gap-[3px] pb-[10px]", !props.isLast && "border-b border-separator")}>
          <View className="flex-row items-center justify-between gap-2">
            <Text className="flex-1 text-lg font-t3-bold text-foreground" numberOfLines={1}>
              {pendingTask.title}
            </Text>
            <View className="flex-row items-center gap-2">
              {statusPill}
              {timestamp !== null ? (
                <Text className="text-base tabular-nums text-foreground-tertiary">{timestamp}</Text>
              ) : null}
              <SymbolView
                name="chevron.right"
                size={13}
                tintColorClassName={"accent-icon-subtle"}
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
      accessibilityHint={accessibilityHint}
      accessibilityLabel={pendingTask.title}
      accessibilityRole="button"
      className="active:bg-subtle"
      onPress={() => onSelectPendingTask(pendingTask)}
      style={{
        borderRadius: SIDEBAR_ROW_RADIUS,
        cursor: "pointer",
        minHeight: 64,
        justifyContent: "center",
        paddingHorizontal: 12,
        paddingVertical: 10,
      }}
    >
      <View className="gap-[3px]">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="flex-1 text-base font-t3-medium text-foreground" numberOfLines={1}>
            {pendingTask.title}
          </Text>
          <View className="flex-row items-center gap-2">
            {statusPill}
            {timestamp !== null ? (
              <Text className="text-xs tabular-nums text-foreground-muted" numberOfLines={1}>
                {timestamp}
              </Text>
            ) : null}
          </View>
        </View>
        {subtitleRow}
      </View>
    </Pressable>
  );

  return (
    <ControlPillMenu
      actions={isDraft ? DRAFT_TASK_MENU_ACTIONS : PENDING_TASK_MENU_ACTIONS}
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
  readonly environmentMachine?: EnvironmentMachineKind;
  /** A message for this thread is waiting in the outbox. */
  readonly hasQueuedMessages?: boolean;
  readonly searchMatch?: EnvironmentThreadSearchMatch;
  readonly searchQuery?: string;
  readonly isLast: boolean;
  /** Sidebar only: the thread currently open in the detail pane. */
  readonly selected?: boolean;
  /** Defaults to window width minus compact margins. */
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => void;
  readonly titleRegenerationSupported: boolean;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly simultaneousSwipeGesture?: ComponentProps<
    typeof ThreadSwipeable
  >["simultaneousWithExternalGesture"];
}) {
  const { width: windowWidth } = useWindowDimensions();
  const { themeAppearance: colorScheme } = useAppearancePreferences();
  const compact = props.variant === "compact";
  const selected = props.selected === true;
  // Recycling-safe: resets when the list container is reused for another
  // thread, so a hover highlight can't leak across rows.
  const [hovered, setHovered] = useRecyclingState(false);

  const theme = useUniwindTheme();
  const screenColor = theme["--color-screen"];
  const drawerColor = theme["--color-drawer"];
  const pressedBackgroundColor = theme["--color-subtle"];
  const selectedBackgroundColor = theme["--color-user-bubble"];
  const selectedForegroundColor = theme["--color-user-bubble-foreground"];

  const { thread, onSelectThread, onArchiveThread, onDeleteThread, onRegenerateThreadTitle } =
    props;
  const status = resolveThreadStatus(thread);
  const pr = useThreadPr(thread);
  const timestamp = relativeTime(
    thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
  );
  const threadAccessibilityLabel = [
    thread.title,
    pr?.accessibilityLabel,
    props.hasQueuedMessages ? "messages queued to send" : null,
  ]
    .filter(Boolean)
    .join(", ");
  const subtitleParts = [props.environmentLabel, thread.branch].filter((part): part is string =>
    Boolean(part),
  );

  const backgroundColor = compact ? screenColor : drawerColor;
  const effectivePressedBackground = selected
    ? themeColorWithAlpha(String(selectedForegroundColor), 0.16)
    : pressedBackgroundColor;
  const effectiveStatus =
    selected && status
      ? {
          ...status,
          pillClassName: "bg-user-bubble-foreground/20",
          textClassName: "text-user-bubble-foreground",
        }
      : status;

  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);
  const handleRegenerateTitle = useCallback(
    () => onRegenerateThreadTitle(thread),
    [onRegenerateThreadTitle, thread],
  );
  const menuActions = useMemo<MenuAction[]>(
    () => [
      THREAD_ROW_MENU_ACTIONS[0]!,
      ...buildThreadTitleRegenerationMenuItems({
        supported: props.titleRegenerationSupported,
        isRegenerating: thread.titleRegeneration != null,
      }),
      THREAD_ROW_MENU_ACTIONS[1]!,
    ],
    [props.titleRegenerationSupported, thread.titleRegeneration],
  );
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
      if (nativeEvent.event === "regenerate-title") handleRegenerateTitle();
      if (nativeEvent.event === "delete") handleDelete();
    },
    [handleArchive, handleDelete, handleRegenerateTitle],
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
            {props.environmentLabel && props.environmentMachine ? (
              <EnvironmentMachineSymbol
                kind={props.environmentMachine}
                size={compact ? 12 : 10}
                tintColorClassName={
                  compact
                    ? "accent-icon-subtle"
                    : selected
                      ? "accent-user-bubble-foreground-muted"
                      : "accent-foreground-muted"
                }
              />
            ) : null}
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
              color={
                selected ? String(selectedForegroundColor) : pullRequestTintColor(pr, colorScheme)
              }
            />
            <Text
              className={`${compact ? "text-sm" : "text-xs"} font-t3-medium ${
                selected ? "text-user-bubble-foreground" : pr.textClassName
              }`}
            >
              {pr.label}
            </Text>
          </View>
        ) : null}
      </View>
    ) : null;

  const rowContent = (close: () => void) =>
    compact ? (
      <Pressable
        accessibilityHint="Swipe left for archive and delete actions"
        accessibilityLabel={threadAccessibilityLabel}
        accessibilityRole="button"
        className="bg-screen active:opacity-70"
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
      >
        <View className="pr-[18px] pt-[10px]" style={{ paddingLeft: THREAD_LIST_COMPACT_INSET }}>
          <View className={cn("gap-[3px] pb-[10px]", !props.isLast && "border-b border-separator")}>
            <View className="flex-row items-center justify-between gap-2">
              <Text className="flex-1 text-lg font-t3-bold text-foreground" numberOfLines={1}>
                {thread.title}
              </Text>
              <View className="flex-row items-center gap-2">
                {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
                {statusPill}
                <Text className="text-base tabular-nums text-foreground-tertiary">{timestamp}</Text>
                <SymbolView
                  name="chevron.right"
                  size={13}
                  tintColorClassName={"accent-icon-subtle"}
                  type="monochrome"
                />
              </View>
            </View>
            {props.searchMatch ? (
              <ThreadSearchMatchExcerpt
                compact
                match={props.searchMatch}
                query={props.searchQuery ?? ""}
              />
            ) : null}
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
              {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
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
          {props.searchMatch ? (
            <ThreadSearchMatchExcerpt
              match={props.searchMatch}
              query={props.searchQuery ?? ""}
              selected={selected}
            />
          ) : null}
          {subtitleRow}
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
        // Messages-style row actions on long-press. iOS: a real
        // UIContextMenuInteraction with the row as the zoom preview (needs the
        // patched @react-native-menu, see
        // patches/@react-native-menu__menu@2.0.0.patch — in long-press mode the
        // interaction is hosted by the component view and the underlying
        // UIButton passes touches through, so row taps keep working). Android:
        // ControlPillMenu injects onLongPress into the row and anchors the
        // token-styled dropdown to it; taps and swipes are untouched.
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
