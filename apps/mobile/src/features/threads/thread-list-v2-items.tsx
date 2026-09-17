import {
  resolveWorktreeLifecycle,
  worktreeLifecycleTargets,
  type WorktreeLifecycleAction,
  resolveWorktreeMetadata,
} from "@t3tools/client-runtime/state/worktree-grouping";
import { selectRunningSubprocessTerminalIds } from "@t3tools/client-runtime/state/terminal";
import { worktreeResourceThreadId } from "@t3tools/shared/worktreeResource";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { resolveThreadProviderInstance } from "./thread-provider-instance";
import { RowPressable } from "../../components/RowPressable";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadArrangementOpenAtom } from "../../state/thread-order";
import type { ThreadMoveDestination } from "./threadOrder";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import type { MenuAction } from "@react-native-menu/menu";
import { memo, useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import { Alert, Platform, Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import type { ThreadListProvider } from "../../state/thread-list-environments";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ProviderIcon, ProviderInstanceIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { useThreadPr } from "../../state/use-thread-pr";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import {
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2SnoozeMenuSelection,
  threadHasUnseenCompletion,
  resolveThreadListV2Status,
  resolveThreadListV2ProviderDrivers,
  resolveThreadListV2SwipeActions,
  type ThreadListV2Status,
} from "./threadListV2";
import { QueuedMessageIcon } from "./queued-message-icon";
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
  approval: { label: "Approval", className: "text-warning-foreground" },
  input: { label: "Input", className: "text-foreground-secondary" },
  working: { label: "Working", className: "text-adaptive-sky-600-400" },
  failed: { label: "Failed", className: "text-danger-foreground" },
};

function threadTimeLabel(thread: EnvironmentThreadShell): string {
  return relativeTime(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt);
}

// Menus keep lifecycle and title regeneration together. Archive keeps its
// own surface (thread screen / settings) rather than crowding v2 rows.
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
  return (
    <View
      className={cn(
        "mb-1.5 mt-4 flex-row items-center gap-2.5",
        props.pane === "sidebar" ? "px-3" : "px-5",
      )}
    >
      <Text className="text-xs font-t3-medium text-foreground-tertiary">{props.label}</Text>
      <View className="h-px flex-1 bg-border" />
    </View>
  );
});

export const ThreadListV2SnoozedShelfHeader = memo(function ThreadListV2SnoozedShelfHeader(props: {
  readonly count: number;
  readonly disabled?: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
}) {
  return (
    <Pressable
      accessibilityHint={
        props.expanded ? "Collapses the snoozed threads." : "Expands the snoozed threads."
      }
      accessibilityLabel={props.count === 1 ? "1 snoozed thread" : `${props.count} snoozed threads`}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled, expanded: props.expanded }}
      className={cn(
        "mb-1.5 mt-4 flex-row items-center gap-2.5",
        props.pane === "sidebar" ? "px-3" : "px-5",
      )}
      disabled={props.disabled}
      onPress={props.onToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text className="text-xs font-t3-medium text-foreground-secondary">
        {props.expanded ? "Snoozed" : `Snoozed (${props.count})`}
      </Text>
      <View className="h-px flex-1 bg-primary/20" />
      <SymbolView
        name="chevron.down"
        size={10}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
        style={{ transform: [{ rotate: props.expanded ? "180deg" : "0deg" }] }}
      />
    </Pressable>
  );
});

export const ThreadListV2SettledShelfHeader = memo(function ThreadListV2SettledShelfHeader(props: {
  readonly count: number;
  readonly disabled?: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
}) {
  return (
    <Pressable
      accessibilityHint={
        props.expanded ? "Collapses the settled threads." : "Expands the settled threads."
      }
      accessibilityLabel={props.count === 1 ? "1 settled thread" : `${props.count} settled threads`}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled, expanded: props.expanded }}
      className={cn(
        "mb-1.5 mt-4 flex-row items-center gap-2.5",
        props.pane === "sidebar" ? "px-3" : "px-5",
      )}
      disabled={props.disabled}
      onPress={props.onToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text className="text-xs font-t3-medium text-foreground-tertiary">
        {props.expanded ? "Settled" : `Settled (${props.count})`}
      </Text>
      <View className="h-px flex-1 bg-border" />
      <SymbolView
        name="chevron.down"
        size={10}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
        style={{ transform: [{ rotate: props.expanded ? "180deg" : "0deg" }] }}
      />
    </Pressable>
  );
});

const PENDING_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const DRAFT_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Discard", image: "trash", attributes: { destructive: true } },
];

/**
 * Unsent work, in the same idiom as an active v2 row: it is work the user
 * wrote, so it reads like the thread it will become. The status slot says
 * what happens next, not where the item sits: "Sends on reconnect" stays
 * uncolored because nothing is asked of the user; "Draft" takes the amber the
 * web sidebar uses for drafts, because this one waits on the user.
 */
export const ThreadListV2PendingRow = memo(function ThreadListV2PendingRow(props: {
  readonly pendingTask: PendingNewTask;
  readonly project: EnvironmentProject | null;
  readonly projectTitle?: string;
  readonly environmentLabel: string | null;
  /** Drawn beside the label; ignored while the label is null. */
  readonly environmentMachine?: EnvironmentMachineKind;
  readonly pane?: "screen" | "sidebar";
  /** Draws the "Unsent" divider above the first draft or queued row. */
  readonly showPendingDivider: boolean;
  /** Keeps row hairlines inside a section; section headers draw their own rule. */
  readonly showTrailingDivider?: boolean;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
}) {
  const { pendingTask, onSelectPendingTask, onDeletePendingTask } = props;
  const sidebarPane = props.pane === "sidebar";
  const isDraft = pendingTask.kind === "draft";
  const projectTitle = props.projectTitle ?? props.project?.title ?? pendingTask.projectTitle ?? "";
  const branch = pendingTask.branch;

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
            environmentId={pendingTask.environmentId}
            faviconPath={props.project.faviconPath}
            size={15}
            projectTitle={projectTitle}
            workspaceRoot={props.project.workspaceRoot}
          />
        ) : null}
        <Text className="flex-1 text-sm font-t3-medium text-foreground-muted" numberOfLines={1}>
          {projectTitle}
        </Text>
        {isDraft ? (
          <View className="flex-row items-center gap-1">
            <SymbolView
              name="square.and.pencil"
              size={10}
              tintColorClassName="accent-adaptive-amber-700-300"
              type="monochrome"
            />
            <Text className="text-xs text-adaptive-amber-700-300">Draft</Text>
          </View>
        ) : (
          <Text className="text-xs text-foreground-tertiary">Sends on reconnect</Text>
        )}
      </View>
      {/* One line, unlike the two an active row allows: a queued title is
          derived from the whole prompt rather than written as a title, so the
          second line is usually a stray word or emoji rather than meaning. */}
      <Text className="mt-1 text-base font-t3-medium text-foreground" numberOfLines={1}>
        {pendingTask.title}
      </Text>
      {branch || props.environmentLabel ? (
        <View className="mt-1 flex-row items-center gap-1">
          <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
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
          {props.environmentLabel && props.environmentMachine ? (
            <EnvironmentMachineSymbol
              kind={props.environmentMachine}
              size={11}
              tintColorClassName="accent-foreground-tertiary"
            />
          ) : null}
        </View>
      ) : null}
    </>
  );

  return (
    <>
      {props.showPendingDivider ? (
        <ThreadListV2SectionDivider label="Unsent" pane={props.pane} />
      ) : null}
      <ControlPillMenu
        actions={isDraft ? DRAFT_TASK_MENU_ACTIONS : PENDING_TASK_MENU_ACTIONS}
        onPressAction={handleMenuAction}
        shouldOpenOnLongPress
      >
        <RowPressable
          accessibilityHint={
            isDraft
              ? "Opens the draft in the new task composer"
              : "Sends when the environment reconnects. Opens the task for editing"
          }
          accessibilityLabel={pendingTask.title}
          accessibilityRole="button"
          key={pendingTask.key}
          className={sidebarPane ? "bg-drawer" : "bg-screen"}
          onPress={() => onSelectPendingTask(pendingTask)}
          style={
            sidebarPane
              ? {
                  borderRadius: SIDEBAR_V2_ROW_RADIUS,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                }
              : undefined
          }
        >
          {sidebarPane ? (
            rowContent
          ) : (
            <View>
              <View className="px-5 py-2.5">{rowContent}</View>
              {props.showTrailingDivider !== false ? (
                <View className="ml-5 h-px bg-border-subtle" />
              ) : null}
            </View>
          )}
        </RowPressable>
      </ControlPillMenu>
    </>
  );
});

interface WorktreeActionProps {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly pinningSupported: boolean;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onSnoozeThread: (thread: EnvironmentThreadShell, until: string) => void;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => void;
  readonly onPinThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => void;
}

function useWorktreeActions(props: WorktreeActionProps) {
  const lifecycle = resolveWorktreeLifecycle(props.threads, new Date().toISOString());
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  const presets = resolveSnoozePresets(new Date());
  const apply = useCallback(
    async (action: WorktreeLifecycleAction, until?: string) => {
      if (
        action === "snooze" &&
        !resolveWorktreeLifecycle(props.threads, new Date().toISOString()).canSnoozeNow
      )
        return false;
      const members = worktreeLifecycleTargets(props.threads, action, new Date().toISOString());
      let succeeded = true;
      for (const thread of members) {
        switch (action) {
          case "settle":
            succeeded = (await props.onSettleThread(thread)) && succeeded;
            break;
          case "unsettle":
            await props.onUnsettleThread(thread);
            break;
          case "pin":
            await props.onPinThread(thread);
            break;
          case "unpin":
            await props.onUnpinThread(thread);
            break;
          case "snooze":
            if (until) await props.onSnoozeThread(thread, until);
            break;
          case "unsnooze":
            await props.onUnsnoozeThread(thread);
            break;
        }
      }
      return succeeded;
    },
    [
      props.threads,
      props.onSettleThread,
      props.onUnsettleThread,
      props.onPinThread,
      props.onUnpinThread,
      props.onSnoozeThread,
      props.onUnsnoozeThread,
    ],
  );
  const actions: MenuAction[] = [
    ...(props.pinningSupported
      ? [
          {
            id: lifecycle.isPinned ? "unpin" : "pin",
            title: lifecycle.isPinned ? "Unpin worktree" : "Pin worktree",
            image: lifecycle.isPinned ? "pin.slash" : "pin",
          },
        ]
      : []),
    ...(props.settlementSupported
      ? [
          {
            id: lifecycle.isSettled ? "unsettle" : "settle",
            title: lifecycle.isSettled ? "Unsettle worktree" : "Settle worktree",
            image: "checkmark",
          },
        ]
      : []),
    ...(props.snoozeSupported
      ? [
          lifecycle.isSnoozed
            ? { id: "unsnooze", title: "Unsnooze worktree", image: "clock" }
            : {
                id: "snooze",
                title: "Snooze worktree",
                image: "clock",
                attributes: { disabled: !lifecycle.canSnoozeNow },
                subactions: [
                  ...presets.map((preset) => ({
                    id: `snooze:${preset.id}`,
                    title: preset.label,
                    subtitle: preset.whenLabel,
                  })),
                  { id: "snooze:custom", title: "Custom…" },
                ],
              },
        ]
      : []),
  ];
  const handleMenuAction = ({
    nativeEvent: { event },
  }: {
    readonly nativeEvent: { readonly event: string };
  }) => {
    if (
      event === "pin" ||
      event === "unpin" ||
      event === "settle" ||
      event === "unsettle" ||
      event === "unsnooze"
    )
      void apply(event);
    if (event === "snooze:custom") {
      setCustomSnoozeOpen(true);
      return;
    }
    const selection = resolveThreadListV2SnoozeMenuSelection({
      event,
      displayedPresets: presets,
      now: new Date(),
    });
    if (selection._tag === "selected") void apply("snooze", selection.preset.snoozedUntil);
    if (selection._tag === "expired")
      Alert.alert("Could not snooze worktree", "That snooze time has passed. Choose another time.");
  };
  return {
    lifecycle,
    apply,
    actions,
    handleMenuAction,
    customSnoozeSheet: customSnoozeOpen ? (
      <CustomSnoozeSheet
        onClose={() => setCustomSnoozeOpen(false)}
        onSnooze={(until) => void apply("snooze", until)}
      />
    ) : null,
  };
}

export const ThreadListV2Row = memo(function ThreadListV2Row(props: {
  readonly worktreeThreads?: ReadonlyArray<EnvironmentThreadShell>;
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  /** A message for this thread is waiting in the outbox. */
  readonly hasQueuedMessages?: boolean;
  /** Snoozed-shelf row: shows its wake time and offers Wake. */
  readonly snoozed?: boolean;
  /** Pinned-block row: shows the pin glyph and offers Unpin. */
  readonly pinned?: boolean;
  /** Preformatted against the parent minute tick so this memoized row's
      countdown keeps moving. */
  readonly snoozeWakeLabelText?: string;
  /** Parent minute tick passed as a prop so this memoized row refreshes its
      native snooze menu while mounted. */
  readonly snoozePresetMinute: string;
  readonly project: EnvironmentProject | null;
  readonly projectTitle?: string;
  /** Keep the environment's provider array stable across unrelated list updates. */
  readonly providers: ReadonlyArray<ThreadListProvider> | undefined;
  /** Which machine hosts the thread. Null when only one environment is
      connected — repeating the same label on every row is noise. Mirrors
      the web sidebar's remote-environment cloud icon, but as text since
      phones have no hover tooltips. */
  readonly environmentLabel: string | null;
  /** Drawn after the label so the machine reads at a glance; ignored while
      the label is null. */
  readonly environmentMachine?: EnvironmentMachineKind;
  /** Hosting surface. "screen" (default) renders the compact Home idiom:
      flat edge-to-edge rows on the screen background with inset hairlines.
      "sidebar" renders the iPad split-view idiom: rounded rows blending
      into the drawer surface, selection filled with the accent color —
      matching the v1 sidebar rows. */
  readonly pane?: "screen" | "sidebar";
  /** Keeps row hairlines inside a section; section headers draw their own rule. */
  readonly showTrailingDivider?: boolean;
  /** Highlights the thread open in the detail pane (iPad split view). The
      compact Home list never sets it — phones navigate away on select. */
  readonly selected?: boolean;
  /** Override for narrow panes (iPad sidebar); defaults to window width. */
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onRenameThread: (thread: EnvironmentThreadShell) => void;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (thread: EnvironmentThreadShell, snoozedUntil: string) => void;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onPinThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => void;
  /** False on environments whose server predates thread.settle/unsettle:
      swipe + menu fall back to Archive instead of failing on use. */
  readonly settlementSupported: boolean;
  /** False on servers that predate thread.snooze/unsnooze. */
  readonly snoozeSupported: boolean;
  /** False on servers that predate thread.pin/unpin. */
  readonly pinningSupported: boolean;
  /** False on servers that predate thread title regeneration. */
  readonly titleRegenerationSupported: boolean;
  /** Server supports reordering this card's section. */
  readonly reorderSupported?: boolean;
  readonly onMoveThread?: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => void;
  /** Position flags for the card's section so the menu disables the move that
      would fall off the end of the list. */
  readonly canMoveUp?: boolean;
  readonly canMoveDown?: boolean;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
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
    onRenameThread,
    onRegenerateThreadTitle,
    onNewThreadOnBranch,
    onArchiveThread,
    onMoveThread,
  } = props;
  const snoozedRow = props.snoozed === true;

  const { providerDrivers, providerInstance, providerIconUrl } = useMemo(() => {
    const provider = props.providers?.find(
      (candidate) =>
        candidate.instanceId ===
        (thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId),
    );
    return {
      providerDrivers: resolveThreadListV2ProviderDrivers(thread, props.providers),
      providerInstance: resolveThreadProviderInstance(props.providers, thread),
      providerIconUrl: provider?.iconUrl,
    };
  }, [thread, props.providers]);

  const theme = useUniwindTheme();
  const screenColor = theme["--color-screen"];
  const drawerColor = theme["--color-drawer"];
  const selectedBackgroundColor =
    theme[Platform.OS === "android" ? "--color-thread-selected" : "--color-user-bubble"];
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected === true;
  const providerIconSurfaceColor = sidebarPane
    ? selected
      ? selectedBackgroundColor
      : Platform.OS === "android"
        ? screenColor
        : drawerColor
    : screenColor;
  const status = resolveThreadListV2Status(thread);
  // "Done" marks a completion the user has not opened yet — same emerald
  // label as the web sidebar, sourced from the server-side visited watermark
  // so checking a thread on any device clears it everywhere.
  const isUnread = status === "ready" && threadHasUnseenCompletion(thread);
  const statusLabel =
    STATUS_LABEL_BY_STATUS[status] ??
    (isUnread ? { label: "Done", className: "text-adaptive-emerald-700-300" } : undefined);
  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleRename = useCallback(() => onRenameThread(thread), [onRenameThread, thread]);
  const handleRegenerateTitle = useCallback(
    () => onRegenerateThreadTitle(thread),
    [onRegenerateThreadTitle, thread],
  );
  const worktreeActions = useWorktreeActions({
    ...props,
    threads: props.worktreeThreads ?? [thread],
  });
  const handleSettle = useCallback(() => worktreeActions.apply("settle"), [worktreeActions.apply]);
  const handleSnooze = useCallback(
    (until: string) => void worktreeActions.apply("snooze", until),
    [worktreeActions.apply],
  );
  const handleUnsnooze = useCallback(
    () => void worktreeActions.apply("unsnooze"),
    [worktreeActions.apply],
  );
  const handleUnsettle = useCallback(
    () => void worktreeActions.apply("unsettle"),
    [worktreeActions.apply],
  );
  const handlePin = useCallback(() => void worktreeActions.apply("pin"), [worktreeActions.apply]);
  const handleUnpin = useCallback(
    () => void worktreeActions.apply("unpin"),
    [worktreeActions.apply],
  );
  const handleMoveUp = useCallback(() => onMoveThread?.(thread, "up"), [onMoveThread, thread]);
  const handleMoveDown = useCallback(() => onMoveThread?.(thread, "down"), [onMoveThread, thread]);
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);

  // Swipe: the v2 primary action is the lifecycle transition. Un-settling a
  // settled row keeps it active until new activity clears the user override.
  const canUnsettle = worktreeActions.lifecycle.isSettled;
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
    variant: canUnsettle ? "slim" : "card",
    settlementSupported: props.settlementSupported,
    snoozeSupported: props.snoozeSupported,
    snoozable: worktreeActions.lifecycle.canSnoozeNow,
    snoozed: worktreeActions.lifecycle.isSnoozed,
  });
  const snoozePresets = useMemo(
    () => (swipeActions.secondary === "snooze" ? resolveSnoozePresets(new Date()) : ([] as const)),
    [props.snoozePresetMinute, swipeActions.secondary],
  );
  const snoozePresetActions = useMemo<MenuAction[]>(
    () => [
      ...snoozePresets.map((preset) => ({
        id: `snooze:${preset.id}`,
        title: preset.label,
        subtitle: preset.whenLabel,
      })),
      { id: "snooze:custom", title: "Custom…" },
    ],
    [snoozePresets],
  );
  // Pinned cards keep the full lifecycle menu; only the pin item flips to
  // Unpin. (Settling a pinned thread clears the pin server-side; snoozing
  // hides the card until wake with the pin intact.)
  const arrangementMenuItems = useMemo<MenuAction[]>(
    () => [
      ...(props.reorderSupported === true
        ? [
            { id: "arrange", title: "Arrange threads…", image: "line.3.horizontal" },
            {
              id: "move-up",
              title: "Move up",
              image: "arrow.up",
              attributes: { disabled: props.canMoveUp !== true },
            } satisfies MenuAction,
            {
              id: "move-down",
              title: "Move down",
              image: "arrow.down",
              attributes: { disabled: props.canMoveDown !== true },
            } satisfies MenuAction,
          ]
        : []),
    ],
    [props.canMoveDown, props.canMoveUp, props.reorderSupported],
  );
  const titleMenuItems = useMemo<MenuAction[]>(
    () => [
      { id: "rename", title: "Rename", image: "square.and.pencil" },
      ...buildThreadTitleRegenerationMenuItems({
        supported: props.titleRegenerationSupported,
        isRegenerating: thread.titleRegeneration != null,
      }),
    ],
    [props.titleRegenerationSupported, thread.titleRegeneration],
  );
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "new-thread-on-branch") onNewThreadOnBranch(thread);
      if (nativeEvent.event === "settle") handleSettle();
      if (nativeEvent.event === "unsettle") handleUnsettle();
      if (nativeEvent.event === "unsnooze") handleUnsnooze();
      if (nativeEvent.event === "pin") handlePin();
      if (nativeEvent.event === "unpin") handleUnpin();
      if (nativeEvent.event === "arrange") appAtomRegistry.set(threadArrangementOpenAtom, true);
      if (nativeEvent.event === "move-up") handleMoveUp();
      if (nativeEvent.event === "move-down") handleMoveDown();
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "rename") handleRename();
      if (nativeEvent.event === "regenerate-title") handleRegenerateTitle();
      if (nativeEvent.event === "delete") handleDelete();
      if (nativeEvent.event.startsWith("snooze:"))
        worktreeActions.handleMenuAction({ nativeEvent });
    },
    [
      onNewThreadOnBranch,
      thread,
      handleArchive,
      handleDelete,
      handleRegenerateTitle,
      handleRename,
      handleMoveDown,
      handleMoveUp,
      handlePin,
      handleSettle,
      handleSnooze,
      handleUnpin,
      handleUnsettle,
      handleUnsnooze,
      worktreeActions.handleMenuAction,
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
          accessibilityLabel: "Unsettle worktree",
          icon: "arrow.uturn.backward" as const,
          label: "Un-settle",
          onPress: handleUnsettle,
        }
      : {
          accessibilityLabel: "Settle worktree",
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
            accessibilityLabel: "Choose when to snooze worktree",
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
      ? `Opens the thread. Swipe left to ${primaryAction.label.toLowerCase()} the worktree.`
      : `Opens the thread. Swipe left for worktree ${primaryAction.label.toLowerCase()} and snooze actions.`;

  const rowContent = (close: () => void) => (
    <RowPressable
      interactionClassName={
        selected
          ? Platform.OS === "android"
            ? "bg-thread-selected-foreground"
            : "bg-user-bubble-foreground"
          : "bg-primary"
      }
      accessibilityHint={swipeAccessibilityHint}
      accessibilityLabel={
        props.hasQueuedMessages ? `${thread.title}, messages queued to send` : thread.title
      }
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={() => {
        close();
        onSelectThread(thread);
      }}
      style={{
        backgroundColor: selected ? selectedBackgroundColor : providerIconSurfaceColor,
        borderRadius: SIDEBAR_V2_ROW_RADIUS,
      }}
    >
      <View
        className={cn(
          "min-h-[36px] flex-row items-center gap-2 py-1",
          sidebarPane ? "px-3" : "px-5",
        )}
      >
        <View className="min-w-0 flex-1">
          <Text
            numberOfLines={1}
            className={cn(
              "text-base",
              selected
                ? Platform.OS === "android"
                  ? "text-thread-selected-foreground"
                  : "text-user-bubble-foreground"
                : isUnread || status === "input" || status === "approval"
                  ? "font-t3-medium text-foreground"
                  : "text-foreground-muted",
            )}
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
          {status === "failed" && thread.runtime?.lastError ? (
            <Text className="text-xs text-danger-foreground" numberOfLines={1}>
              {thread.runtime.lastError}
            </Text>
          ) : null}
        </View>
        {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
        {snoozedRow && props.snoozeWakeLabelText ? (
          <Text className="text-xs text-foreground-secondary">{props.snoozeWakeLabelText}</Text>
        ) : statusLabel ? (
          <Text
            className={cn(
              "text-xs",
              selected
                ? Platform.OS === "android"
                  ? "text-thread-selected-foreground"
                  : "text-user-bubble-foreground"
                : statusLabel.className,
            )}
          >
            {statusLabel.label}
          </Text>
        ) : null}
        {providerInstance ? (
          // Earlier owners peek out behind the current provider so a
          // handed-off thread shows where it has been. The current owner
          // keeps its account badge so same-driver instances stay distinct.
          <View className="flex-row items-center">
            {providerDrivers.slice(0, -1).map((driver, index) => (
              <View key={`${driver}:${index}`} className="-mr-1 opacity-30">
                <ProviderIcon provider={driver} size={12} />
              </View>
            ))}
            <ProviderInstanceIcon
              iconUrl={providerIconUrl}
              provider={providerInstance.driverKind}
              size={14}
              displayName={providerInstance.displayName}
              accentColor={providerInstance.accentColor}
              showBadge={providerInstance.showBadge}
              surfaceColor={providerIconSurfaceColor}
            />
          </View>
        ) : null}
      </View>
    </RowPressable>
  );

  return (
    <View collapsable={false}>
      {worktreeActions.customSnoozeSheet}
      <ThreadSwipeable
        threadKey={`${thread.environmentId}:${thread.id}`}
        backgroundColor={sidebarPane && Platform.OS !== "android" ? drawerColor : screenColor}
        compactActions={variant === "slim"}
        containerStyle={
          Platform.OS === "android"
            ? { borderRadius: 20, overflow: "hidden", marginHorizontal: 8, marginVertical: 2 }
            : sidebarPane
              ? { borderRadius: SIDEBAR_V2_ROW_RADIUS, overflow: "hidden" }
              : undefined
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
        resetKey={`${thread.environmentId}:${thread.id}:${variant}:${snoozedRow}:${thread.settledAt}:${thread.unsettledAt}:${thread.snoozedUntil}`}
        simultaneousWithExternalGesture={props.simultaneousSwipeGesture}
        threadTitle={thread.title}
      >
        {(close) => (
          <ControlPillMenu
            actions={[
              ...(thread.branch
                ? [
                    {
                      id: "new-thread-on-branch",
                      title:
                        Platform.OS === "ios"
                          ? "New thread on branch"
                          : `New thread on ${thread.branch}`,
                      image: "square.and.pencil",
                    },
                  ]
                : []),
              ...worktreeActions.actions,
              ...arrangementMenuItems,
              ...titleMenuItems,
              ...(!props.settlementSupported ? [LEGACY_MENU_ACTIONS[0]!] : []),
              { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
            ]}
            onPressAction={handleMenuAction}
            shouldOpenOnLongPress
          >
            {rowContent(close)}
          </ControlPillMenu>
        )}
      </ThreadSwipeable>
    </View>
  );
});

export const ThreadListV2WorktreeHeader = memo(function ThreadListV2WorktreeHeader(
  props: WorktreeActionProps & {
    readonly threads: ReadonlyArray<EnvironmentThreadShell>;
    readonly project: EnvironmentProject | null;
    readonly projectTitle: string;
    readonly environmentMachine?: EnvironmentMachineKind;
    readonly environmentLabel: string | null;
    readonly count: number;
  },
) {
  const worktreeActions = useWorktreeActions(props);
  const metadata = useMemo(() => resolveWorktreeMetadata(props.threads), [props.threads]);
  const thread = metadata.thread;
  const prThread = useMemo(
    () => ({
      ...thread,
      pullRequests: metadata.pullRequests,
      linkedPullRequest: metadata.linkedPullRequest,
      branchPullRequest: metadata.branchPullRequest,
    }),
    [thread, metadata],
  );
  const pr = useThreadPr(prThread);
  const sessions = useKnownTerminalSessions({
    environmentId: thread.environmentId,
    threadId: worktreeResourceThreadId(thread.projectId, thread.worktreePath),
  });
  const terminalCount = useMemo(
    () => selectRunningSubprocessTerminalIds(sessions).length,
    [sessions],
  );
  const checkout = thread.branch ?? thread.worktreePath?.split(/[\\/]/).at(-1) ?? "Local checkout";
  return (
    <>
      {worktreeActions.customSnoozeSheet}
      <ControlPillMenu
        actions={worktreeActions.actions}
        onPressAction={worktreeActions.handleMenuAction}
        shouldOpenOnLongPress
      >
        <View accessibilityRole="header" className="mt-2.5 gap-0 px-5">
          <View className="flex-row items-center gap-1.5">
            {props.project ? (
              <ProjectFavicon
                environmentId={thread.environmentId}
                faviconPath={props.project.faviconPath}
                size={15}
                projectTitle={props.projectTitle}
                workspaceRoot={props.project.workspaceRoot}
              />
            ) : null}
            <Text className="min-w-0 shrink text-sm text-foreground-tertiary" numberOfLines={1}>
              {props.projectTitle}
            </Text>
            <View accessibilityLabel={props.environmentLabel ?? "Environment"}>
              <EnvironmentMachineSymbol
                kind={props.environmentMachine ?? "server"}
                size={12}
                tintColorClassName="accent-foreground-muted"
              />
            </View>
            {worktreeActions.lifecycle.isPinned ? (
              <SymbolView
                name="pin"
                size={11}
                tintColorClassName="accent-foreground-muted"
                type="monochrome"
              />
            ) : null}
            <Text className="ml-auto text-xs tabular-nums text-foreground-tertiary">
              {threadTimeLabel(thread)}
            </Text>
          </View>
          <View className="flex-row items-center gap-1.5">
            <Text className="min-w-0 flex-1 text-xs text-foreground-tertiary" numberOfLines={1}>
              {checkout}
              {props.environmentLabel ? ` · ${props.environmentLabel}` : ""}
            </Text>
            {terminalCount > 0 ? (
              <View accessibilityLabel={`${terminalCount} running terminal processes`}>
                <SymbolView
                  name="terminal"
                  size={13}
                  tintColorClassName="accent-adaptive-emerald-600-400"
                />
              </View>
            ) : null}
            {pr ? (
              <View
                className="flex-row items-center gap-1"
                accessibilityLabel={pr.accessibilityLabel}
              >
                <SymbolView
                  name={pr.kind === "stack" ? "square.3.layers.3d" : "arrow.triangle.pull"}
                  size={12}
                  tintColorClassName={
                    pr.state === "merged"
                      ? "accent-adaptive-violet-600-400"
                      : pr.state === "closed"
                        ? "accent-adaptive-rose-600-400"
                        : pr.state === "open" && !pr.isDraft
                          ? "accent-adaptive-emerald-600-400"
                          : "accent-foreground-muted"
                  }
                />
                <Text className={cn("text-xs", pr.textClassName)}>
                  {pr.kind === "stack" || pr.others > 0 ? pr.label : `#${pr.label}`}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      </ControlPillMenu>
    </>
  );
});
