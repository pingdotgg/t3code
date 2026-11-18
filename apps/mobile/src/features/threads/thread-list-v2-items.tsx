import * as Dialog from "../../components/ui/Dialog";
import type { ThreadRowProviderInstance } from "./thread-provider-instance";
import {
  THREAD_LIST_V2_MONO_FONT as MONO_FONT,
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
  THREAD_LIST_V2_ROW_DIVIDERS,
  selectedThreadRowColors,
  getThreadListV2NewBranchMenuTitle,
  getThreadListV2RowAppearance,
} from "./thread-list-v2-row-appearance";
import { RowPressable } from "../../components/ui/RowPressable";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadArrangementOpenAtom } from "../../state/thread-order";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import { THREAD_ACTIVITY_PRESENTATION } from "./threadActivityPresentation";
import type { ThreadMoveDestination } from "./threadOrder";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import {
  formatWorkingDurationLabel,
  resolveThreadWorkingStartedAt,
} from "@t3tools/client-runtime/state/models";
import type { ProjectFolderDot } from "@t3tools/client-runtime/state/project-folders";
import { withWorkingSubagents } from "@t3tools/client-runtime/state/subagent-activity";
import {
  formatThreadActivity,
  resolveThreadActivityForDisplay,
  THREAD_ACTIVITY_PHASE_LABEL,
} from "@t3tools/client-runtime/state/thread-execution";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ThreadPinScope,
} from "@t3tools/contracts";
import { toServerClock } from "@t3tools/client-runtime/clock";
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import type { MenuAction } from "@react-native-menu/menu";
import { memo, useCallback, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import {
  type AccessibilityActionEvent,
  Platform,
  Pressable,
  Text as RNText,
  useWindowDimensions,
  View,
} from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import Reanimated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";

import type { ThreadListProvider } from "../../state/thread-list-environments";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ProjectFavicon, useProjectTitleColorClassName } from "../../components/ProjectFavicon";
import {
  ProviderIcon,
  ProviderInstanceIcon,
  providerInstanceNameLabel,
} from "../../components/ProviderIcon";
import { useNowAfter } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { copyThreadReference } from "../../lib/copyThreadReference";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useEnvironmentScope } from "../../state/session";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  pendingDraftBranchNeedsRefs,
  resolvePendingDraftBranch,
} from "../../state/pending-new-tasks-model";
import { useBranches } from "../../state/queries";
import { useNewTaskProjectDefaults } from "./use-new-task-project-defaults";
import {
  resolveThreadPrBadgeAction,
  type ThreadPrPresentation,
} from "../../state/thread-pr-presentation";
import { useThreadPr } from "../../state/use-thread-pr";
import { useSwipeRowDormant } from "../home/swipe-row-activation";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import { canTurnThreadIntoProject, turnThreadIntoProject } from "./turnThreadIntoProject";
import { threadCanArchive } from "../home/threadArchive";
import {
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozePresets,
  threadHasUnseenCompletion,
  resolveThreadListV2RowStatus,
  resolveThreadListV2Status,
  resolveThreadListV2ProviderDrivers,
  resolveThreadListV2SwipeActions,
  layoutThreadListV2RowMenuActions,
  threadListV2RowAccessibilityLabel,
  type ThreadListV2GroupOverflowListItem,
  type ThreadListV2Item,
  type ThreadListV2Status,
} from "./threadListV2";
import { THREAD_GROUP_INDENT, ThreadGroupTreeLine } from "./ThreadGroupTreeLine";
import { QueuedMessageIcon } from "./queued-message-icon";
import { shouldRecedeThreadRow } from "./thread-row-emphasis";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { pullRequestStatus } from "../pull-requests/pullRequestStatus";

interface StatusLabel {
  // Null when the icon and timer carry the status on their own.
  readonly label: string | null;
  readonly icon: AppSymbolName;
  readonly className: string;
  readonly iconTintClassName: string;
}
const STATUS_LABEL_BY_STATUS: Partial<Record<ThreadListV2Status, StatusLabel>> = {
  approval: {
    label: "Approval",
    icon: "exclamationmark.shield",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
  },
  input: {
    label: "Input",
    icon: "questionmark.bubble",
    className: "text-adaptive-indigo-600-300",
    iconTintClassName: "accent-adaptive-indigo-600-300",
  },
  request: {
    label: "Request",
    icon: "person.crop.circle",
    className: "text-adaptive-fuchsia-600-300",
    iconTintClassName: "accent-adaptive-fuchsia-600-300",
  },
  working: {
    label: null,
    icon: "circle.dashed",
    className: "text-adaptive-sky-600-400",
    iconTintClassName: "accent-adaptive-sky-600-400",
  },
  waiting: {
    label: null,
    icon: "circle.dashed.inset.filled",
    className: "text-foreground-muted",
    iconTintClassName: "accent-foreground-muted",
  },
  failed: {
    label: "Failed",
    icon: "exclamationmark.circle",
    className: "text-danger-foreground",
    iconTintClassName: "accent-danger-foreground",
  },
  limited: {
    label: "Limited",
    icon: "exclamationmark.circle",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
  },
};
const DONE_STATUS_LABEL: StatusLabel = {
  label: "Done",
  icon: "checkmark.circle",
  className: "text-adaptive-emerald-700-300",
  iconTintClassName: "accent-adaptive-emerald-700-300",
};

// DM Sans has no tabular figures, so a ticking timer in it reflows the row every second.
const TABULAR_DURATION_STYLE = {
  fontFamily: Platform.OS === "ios" ? "System" : "sans-serif",
  fontWeight: "700",
  fontVariant: ["tabular-nums"],
} as const;

function ThreadListV2Duration(props: {
  readonly environmentId: EnvironmentId;
  readonly startedAt: string | null;
  readonly leadingSpace: boolean;
}) {
  const startedAtMs = Date.parse(props.startedAt ?? "");
  const nowMs = useVisibleSecondClock(Number.isFinite(startedAtMs));
  if (!Number.isFinite(startedAtMs)) return null;
  return (
    <>
      {props.leadingSpace ? " " : null}
      <RNText style={TABULAR_DURATION_STYLE}>
        {formatWorkingDurationLabel(toServerClock(props.environmentId, nowMs) - startedAtMs)}
      </RNText>
    </>
  );
}

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

const LEGACY_MENU_ACTIONS: MenuAction[] = [
  { id: "archive", title: "Archive", image: "archivebox" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

// The section header's gap-2.5.
const FOLDER_HEADER_ICON_GAP = 10;

/** A folder header's project icon; its rows indent by it to sit under the folder name. */
function useFolderHeaderIconSize() {
  const { fontScale } = useWindowDimensions();
  return useScaledTextRole("label").fontSize * 1.25 * fontScale;
}

function ThreadListV2Section(props: {
  readonly label: string;
  readonly labelClassName?: string | null;
  readonly icon?: ReactNode;
  readonly pane?: "screen" | "sidebar";
  readonly tone?: "default" | "snoozed";
  readonly accessory?: ReactNode;
  readonly disclosure?: {
    readonly expanded: boolean;
    readonly disabled?: boolean;
    readonly onToggle: () => void;
    readonly accessibilityLabel: string;
    readonly accessibilityHint: string;
  };
}) {
  const snoozed = props.tone === "snoozed";
  const sidebarPane = props.pane === "sidebar";
  const className = cn(
    "mb-1.5 mt-4 flex-row items-center gap-2.5",
    props.pane === "sidebar" ? "px-3" : "px-5",
  );
  const content = (
    <>
      {props.icon}
      <Text
        className={cn(
          "text-xs font-t3-medium",
          props.labelClassName ??
            (sidebarPane
              ? "text-drawer-foreground-muted"
              : snoozed
                ? "text-foreground-secondary"
                : "text-foreground-tertiary"),
        )}
      >
        {props.label}
      </Text>
      {props.accessory}
      <View
        className={cn(
          "h-px flex-1",
          snoozed ? "bg-primary/20" : sidebarPane ? "bg-drawer-border" : "bg-border",
        )}
      />
      {props.disclosure ? (
        <SymbolView
          name="chevron.down"
          size={10}
          tintColorClassName={
            sidebarPane
              ? "accent-drawer-foreground-muted"
              : snoozed
                ? "accent-icon-muted"
                : "accent-foreground-muted"
          }
          type="monochrome"
          style={{ transform: [{ rotate: props.disclosure.expanded ? "180deg" : "0deg" }] }}
        />
      ) : null}
    </>
  );

  return props.disclosure ? (
    <Pressable
      accessibilityHint={props.disclosure.accessibilityHint}
      accessibilityLabel={props.disclosure.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{
        disabled: props.disclosure.disabled,
        expanded: props.disclosure.expanded,
      }}
      className={className}
      disabled={props.disclosure.disabled}
      onPress={props.disclosure.onToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {content}
    </Pressable>
  ) : (
    <View className={className}>{content}</View>
  );
}

const ThreadListV2SectionDivider = memo(function ThreadListV2SectionDivider(props: {
  readonly label: string;
  readonly pane?: "screen" | "sidebar";
}) {
  return <ThreadListV2Section {...props} />;
});

type ThreadListV2ShelfHeaderProps = {
  readonly count: number;
  readonly disabled?: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
};

const SHELF_LABEL = { working: "Working", snoozed: "Snoozed", settled: "Settled" } as const;

function ThreadListV2ShelfHeader(
  props: ThreadListV2ShelfHeaderProps & { readonly kind: keyof typeof SHELF_LABEL },
) {
  const label = SHELF_LABEL[props.kind];
  return (
    <ThreadListV2Section
      label={props.expanded ? label : `${label} (${props.count})`}
      pane={props.pane}
      tone={props.kind === "snoozed" ? "snoozed" : "default"}
      disclosure={{
        expanded: props.expanded,
        disabled: props.disabled,
        onToggle: props.onToggle,
        accessibilityLabel: `${props.count} ${props.kind} ${props.count === 1 ? "thread" : "threads"}`,
        accessibilityHint: `${props.expanded ? "Collapses" : "Expands"} the ${props.kind} threads.`,
      }}
    />
  );
}

const FOLDER_DOT = {
  attention: { className: "bg-warning-foreground", label: "Needs attention" },
  failed: { className: "bg-danger-foreground", label: "Failed" },
  unread: { className: "bg-adaptive-emerald-600-400", label: "Unread" },
  working: { className: "bg-adaptive-sky-600-400", label: "Working" },
} as const;

export const ThreadListV2ProjectFolderHeader = memo(
  function ThreadListV2ProjectFolderHeader(props: {
    readonly folderKey: string;
    readonly title: string;
    readonly project: EnvironmentProject | null;
    readonly count: number;
    readonly collapsed: boolean;
    readonly dot: ProjectFolderDot | null;
    readonly onToggle: (folderKey: string) => void;
    readonly pane?: "screen" | "sidebar";
    readonly moveUpKey?: string | null;
    readonly moveDownKey?: string | null;
    /** Absent when no server takes the shared project order. */
    readonly onMove?: ((folderKey: string, targetKey: string) => void) | null;
  }) {
    const dot = props.collapsed && props.dot ? FOLDER_DOT[props.dot] : null;
    const { folderKey, moveUpKey, moveDownKey, onMove } = props;
    const labelClassName = useProjectTitleColorClassName(props.project);
    const iconSize = useFolderHeaderIconSize();
    const header = (
      <ThreadListV2Section
        label={props.collapsed ? `${props.title} (${props.count})` : props.title}
        labelClassName={labelClassName}
        icon={
          props.project ? (
            <ProjectFavicon
              environmentId={props.project.environmentId}
              faviconPath={props.project.faviconPath}
              projectIcon={props.project.projectIcon}
              size={iconSize}
              projectTitle={props.project.title}
              workspaceRoot={props.project.workspaceRoot}
            />
          ) : undefined
        }
        pane={props.pane}
        accessory={
          dot ? (
            <View
              accessibilityLabel={dot.label}
              className={cn("size-2 rounded-full", dot.className)}
            />
          ) : undefined
        }
        disclosure={{
          expanded: !props.collapsed,
          onToggle: () => props.onToggle(props.folderKey),
          accessibilityLabel: `${props.count} ${props.count === 1 ? "thread" : "threads"} in ${props.title}`,
          accessibilityHint: props.collapsed ? "Expands the folder." : "Collapses the folder.",
        }}
      />
    );
    if (!onMove) return header;
    return (
      <Menu
        actions={[
          {
            id: "move-up",
            title: "Move up",
            image: "arrow.up",
            attributes: { disabled: moveUpKey == null },
          },
          {
            id: "move-down",
            title: "Move down",
            image: "arrow.down",
            attributes: { disabled: moveDownKey == null },
          },
        ]}
        onPressAction={({ nativeEvent }) => {
          const target = nativeEvent.event === "move-up" ? moveUpKey : moveDownKey;
          if (target != null) onMove(folderKey, target);
        }}
        shouldOpenOnLongPress
      >
        {header}
      </Menu>
    );
  },
);

export const ThreadListV2WorkingShelfHeader = memo(function ThreadListV2WorkingShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="working" />;
});

export const ThreadListV2SnoozedShelfHeader = memo(function ThreadListV2SnoozedShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="snoozed" />;
});

export const ThreadListV2SettledShelfHeader = memo(function ThreadListV2SettledShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="settled" />;
});

export const ThreadListV2ShowMoreRow = memo(function ThreadListV2ShowMoreRow(props: {
  readonly pane?: "screen" | "sidebar";
  readonly hiddenCount: number;
  /** Older settled threads are loading, or their last read failed. */
  readonly state?: "loading" | "failed";
  readonly onPress: () => void;
}) {
  const label =
    props.state === "loading"
      ? "Loading"
      : props.state === "failed"
        ? "Could not load older threads. Retry"
        : `Show more (${props.hiddenCount} settled hidden)`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        props.state === undefined
          ? `Show ${Math.min(props.hiddenCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT)} more settled threads`
          : label
      }
      disabled={props.state === "loading"}
      onPress={props.onPress}
      className="mx-4 mt-2 items-center rounded-lg border border-dashed border-border py-2.5"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text
        className={
          props.pane === "sidebar"
            ? "text-xs font-t3-medium text-drawer-foreground-muted"
            : "text-xs font-t3-medium text-foreground-muted"
        }
      >
        {label}
      </Text>
    </Pressable>
  );
});

const PENDING_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const DRAFT_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Discard", image: "trash", attributes: { destructive: true } },
];

/** A thread row's first line: the project icon and its name in the icon's colour. */
function ThreadListV2ProjectLine(props: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
  readonly iconSize: number;
  readonly lineHeight: number;
  readonly selected: boolean;
  readonly muted?: boolean;
}) {
  const { project } = props;
  const titleColorClassName = useProjectTitleColorClassName({
    ...project,
    environmentId: props.environmentId,
  });
  return (
    <View
      className="min-w-0 flex-1 flex-row items-center gap-2"
      style={{ height: props.lineHeight, opacity: props.muted ? 0.55 : 1 }}
    >
      <ProjectFavicon
        environmentId={props.environmentId}
        faviconPath={project.faviconPath}
        projectIcon={project.projectIcon}
        size={props.iconSize}
        projectTitle={project.title}
        workspaceRoot={project.workspaceRoot}
      />
      <Text
        className={cn(
          "flex-1 text-sm font-t3-medium",
          props.selected
            ? selectedThreadRowColors.mutedForegroundClassName
            : (titleColorClassName ?? "text-foreground-secondary"),
        )}
        numberOfLines={1}
      >
        {project.title}
      </Text>
    </View>
  );
}

export const ThreadListV2PendingRow = memo(function ThreadListV2PendingRow(props: {
  readonly pendingTask: PendingNewTask;
  readonly selected?: boolean;
  readonly project: EnvironmentProject | null;
  readonly environmentLabel: string | null;
  readonly environmentMachine?: EnvironmentMachineKind;
  readonly pane?: "screen" | "sidebar";
  readonly showPendingDivider: boolean;
  readonly showTrailingDivider?: boolean;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
  readonly fullSwipeWidth?: number;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly activationKey?: string;
  readonly simultaneousSwipeGesture?: ComponentProps<typeof ThreadSwipeable>["simultaneousWith"];
}) {
  const { pendingTask, onSelectPendingTask, onDeletePendingTask } = props;
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const titleTypography = useScaledTextRole("body");
  const metadataTypography = useScaledTextRole("label");
  const projectIconSize = titleTypography.fontSize * 1.25 * fontScale;
  const machineIconSize = metadataTypography.fontSize * fontScale;
  // Android's nonlinear system text scaling can differ from the fontScale estimate.
  const [androidTitleLineHeight, setTitleLineHeight] = useState(
    titleTypography.lineHeight * fontScale,
  );
  const titleLineHeight =
    Platform.OS === "android" ? androidTitleLineHeight : titleTypography.lineHeight * fontScale;
  const dormant = useSwipeRowDormant(props.activationKey);
  const theme = useUniwindTheme();
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected ?? false;
  const rowAppearance = getThreadListV2RowAppearance(theme, sidebarPane, selected);
  const isDraft = pendingTask.kind === "draft";
  const deleteLabel = isDraft ? "Discard" : "Delete";
  const handleDelete = useCallback(
    () => onDeletePendingTask(pendingTask),
    [onDeletePendingTask, pendingTask],
  );
  const deleteAction = useMemo(
    () => ({
      accessibilityLabel: `${deleteLabel} ${pendingTask.title}`,
      destructive: true,
      icon: "trash" as const,
      label: deleteLabel,
      onPress: handleDelete,
    }),
    [deleteLabel, handleDelete, pendingTask.title],
  );
  const projectCwd = props.project?.workspaceRoot || null;
  // Drafts only; the reads are shared per-project atoms, and queued rows skip them.
  const projectDefaults = useNewTaskProjectDefaults(isDraft ? props.project : null);
  const draftDefaults = {
    canChooseWorkspace: !projectDefaults.isScratch,
    defaultMode: projectDefaults.defaultWorkspaceMode,
    defaultModeSettled: projectDefaults.defaultWorkspaceModeSettled,
  };
  const draftBranchRefs = useBranches({
    environmentId: pendingTask.environmentId,
    cwd:
      isDraft && pendingDraftBranchNeedsRefs(pendingTask.draft, draftDefaults) ? projectCwd : null,
  });
  const branch = isDraft
    ? resolvePendingDraftBranch({
        draft: pendingTask.draft,
        defaults: draftDefaults,
        isGitRepo: draftBranchRefs.data?.isRepo ?? true,
        branches: draftBranchRefs.data?.refs ?? [],
        projectCwd,
      })
    : pendingTask.branch;

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "delete") onDeletePendingTask(pendingTask);
    },
    [onDeletePendingTask, pendingTask],
  );

  const titleTextInset = props.project ? projectIconSize + 8 : 0;
  const taskTitle = (
    <Text
      className={cn(
        "flex-1 text-base font-t3-medium",
        selected ? selectedThreadRowColors.foregroundClassName : rowAppearance.foregroundClassName,
      )}
      numberOfLines={2}
      onTextLayout={
        Platform.OS === "android"
          ? ({ nativeEvent }) => {
              const firstLine = nativeEvent.lines[0];
              if (firstLine && Math.abs(firstLine.height - titleLineHeight) > 0.5) {
                setTitleLineHeight(firstLine.height);
              }
            }
          : undefined
      }
    >
      {pendingTask.title}
    </Text>
  );
  const rowContent = (
    <>
      <View className="flex-row items-start gap-2">
        {props.project ? (
          <ThreadListV2ProjectLine
            environmentId={pendingTask.environmentId}
            project={props.project}
            iconSize={projectIconSize}
            lineHeight={titleLineHeight}
            selected={selected}
          />
        ) : (
          taskTitle
        )}
        {isDraft ? (
          <View className="flex-row items-center gap-1" style={{ minHeight: titleLineHeight }}>
            <SymbolView
              name="square.and.pencil"
              size={13}
              tintColorClassName={
                selected
                  ? selectedThreadRowColors.iconTintClassName
                  : "accent-adaptive-amber-700-300"
              }
              type="monochrome"
              weight="semibold"
            />
            <Text
              className={cn(
                "text-xs font-t3-bold",
                selected
                  ? selectedThreadRowColors.foregroundClassName
                  : "text-adaptive-amber-700-300",
              )}
            >
              Draft
            </Text>
          </View>
        ) : null}
      </View>
      {props.project ? (
        <View className="flex-row" style={{ paddingLeft: titleTextInset }}>
          {taskTitle}
        </View>
      ) : null}
      {!isDraft ? (
        <View className="mt-1" style={{ paddingLeft: titleTextInset }}>
          <Text
            className={cn(
              "text-xs",
              selected
                ? selectedThreadRowColors.foregroundClassName
                : rowAppearance.tertiaryForegroundClassName,
            )}
          >
            Sends on reconnect
          </Text>
        </View>
      ) : null}
      {branch || props.environmentLabel ? (
        <View className="mt-1 flex-row items-center gap-1" style={{ paddingLeft: titleTextInset }}>
          {props.environmentLabel && props.environmentMachine ? (
            <EnvironmentMachineSymbol
              kind={props.environmentMachine}
              size={machineIconSize}
              tintColorClassName={
                selected
                  ? selectedThreadRowColors.mutedIconTintClassName
                  : rowAppearance.tertiaryIconTintClassName
              }
            />
          ) : null}
          <Text
            className={cn(
              "shrink text-xs text-foreground-muted",
              selected
                ? selectedThreadRowColors.mutedForegroundClassName
                : rowAppearance.mutedForegroundClassName,
            )}
            numberOfLines={1}
          >
            {branch ? (
              <Text
                className={cn(
                  "text-xs",
                  selected
                    ? selectedThreadRowColors.mutedForegroundClassName
                    : rowAppearance.mutedForegroundClassName,
                )}
                style={{ fontFamily: MONO_FONT }}
              >
                {branch}
              </Text>
            ) : null}
            {branch && props.environmentLabel ? "  ·  " : null}
            {props.environmentLabel ? (
              <Text
                className={cn(
                  "text-xs",
                  selected
                    ? selectedThreadRowColors.mutedForegroundClassName
                    : rowAppearance.tertiaryForegroundClassName,
                )}
              >
                {props.environmentLabel}
              </Text>
            ) : null}
          </Text>
        </View>
      ) : null}
    </>
  );

  return (
    <>
      {props.showPendingDivider ? (
        <ThreadListV2SectionDivider label="Unsent" pane={props.pane} />
      ) : null}
      <ThreadSwipeable
        dormant={dormant}
        threadKey={pendingTask.key}
        backgroundColor={rowAppearance.swipeBackgroundColor}
        containerStyle={rowAppearance.swipeContainerStyle}
        enableTrackpadSwipe
        fullSwipeAction="primary"
        fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
        listAnimatesLayout
        onDelete={handleDelete}
        onSwipeableClose={props.onSwipeableClose}
        onSwipeableWillOpen={props.onSwipeableWillOpen}
        primaryAction={deleteAction}
        secondaryAction={null}
        resetKey={pendingTask.key}
        simultaneousWith={props.simultaneousSwipeGesture}
        threadTitle={pendingTask.title}
      >
        {() => (
          <Menu
            actions={isDraft ? DRAFT_TASK_MENU_ACTIONS : PENDING_TASK_MENU_ACTIONS}
            onPressAction={handleMenuAction}
            shouldOpenOnLongPress
          >
            <RowPressable
              accessibilityHint={
                isDraft
                  ? `Opens the draft in the new task composer. Swipe left to ${deleteLabel.toLowerCase()}.`
                  : `Sends when the environment reconnects. Opens the task for editing. Swipe left to ${deleteLabel.toLowerCase()}.`
              }
              accessibilityLabel={pendingTask.title}
              accessibilityRole="button"
              accessibilityState={{ selected: props.selected ?? false }}
              key={pendingTask.key}
              className={rowAppearance.className}
              interactionClassName={rowAppearance.interactionClassName}
              interactionOpacity={rowAppearance.interactionOpacity}
              onPress={() => onSelectPendingTask(pendingTask)}
              style={rowAppearance.cardStyle}
            >
              {sidebarPane ? (
                rowContent
              ) : (
                <View>
                  <View className={THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME}>{rowContent}</View>
                  {THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider !== false ? (
                    <View className="ml-5 h-px bg-border-subtle" />
                  ) : null}
                </View>
              )}
            </RowPressable>
          </Menu>
        )}
      </ThreadSwipeable>
    </>
  );
});

const ATTACH_MENU_ACTION: MenuAction = { id: "attach", title: "Attach to thread…", image: "link" };
const DETACH_MENU_ACTION: MenuAction = {
  id: "detach",
  title: "Detach from group",
  image: "minus.circle",
};
const SETTLE_GROUP_MENU_ACTION: MenuAction = {
  id: "settle-group-menu",
  title: "Settle group",
  image: "checkmark",
  subactions: [
    { id: "settle-group", title: "Whole group" },
    { id: "settle-group-finished", title: "Only finished threads" },
  ],
};

/** A row's horizontal content inset, where a group's line runs. */
const rowContentInset = (sidebarPane: boolean) => (sidebarPane ? 12 : 20);
const ROW_CONTENT_PADDING_Y = 10;

type ThreadListV2LeadGroup = Extract<NonNullable<ThreadListV2Item["group"]>, { role: "lead" }>;

function ThreadGroupChip(props: {
  readonly group: ThreadListV2LeadGroup;
  readonly selected: boolean;
  readonly tertiaryClassName: string;
  readonly tertiaryTintClassName: string;
  readonly onToggle: () => void;
}) {
  const { group } = props;
  const dot = group.collapsed && group.dot ? FOLDER_DOT[group.dot] : null;
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [
      {
        rotate: withTiming(group.collapsed ? "0deg" : "90deg", {
          duration: 200,
          reduceMotion: ReduceMotion.System,
        }),
      },
    ],
  }));
  return (
    <View className="mt-1.5 flex-row">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={group.collapsed ? "Expand group" : "Collapse group"}
        accessibilityState={{ expanded: !group.collapsed }}
        // Padding cancelled by negative margin grows the touch target without moving the chip.
        className="-m-2.5 flex-row items-center gap-1.5 p-2.5"
        onPress={props.onToggle}
        // Handle long-press so opening the iOS row menu cannot also toggle the group on release.
        onLongPress={() => undefined}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <Reanimated.View style={chevronStyle}>
          <SymbolView
            name="chevron.right"
            size={10}
            tintColorClassName={
              props.selected
                ? selectedThreadRowColors.mutedIconTintClassName
                : props.tertiaryTintClassName
            }
            type="monochrome"
            weight="semibold"
          />
        </Reanimated.View>
        <Text
          className={cn(
            "text-xs tabular-nums",
            props.selected
              ? selectedThreadRowColors.mutedForegroundClassName
              : props.tertiaryClassName,
          )}
        >
          {group.workerCount}
        </Text>
        {dot ? (
          <View
            accessibilityLabel={dot.label}
            className={cn("size-2 rounded-full", dot.className)}
          />
        ) : null}
      </Pressable>
    </View>
  );
}

export const ThreadListV2GroupOverflowRow = memo(function ThreadListV2GroupOverflowRow(props: {
  readonly item: ThreadListV2GroupOverflowListItem;
  readonly onToggle: (leadKey: string, kind: "settled" | "snoozed") => void;
  readonly pane: "screen" | "sidebar";
}) {
  const { item } = props;
  const sidebarPane = props.pane === "sidebar";
  const { fontScale } = useWindowDimensions();
  const labelTypography = useScaledTextRole("label");
  const folderIconSize = useFolderHeaderIconSize();
  const theme = useUniwindTheme();
  const rowAppearance = getThreadListV2RowAppearance(theme, sidebarPane, false);
  const folderIndent = item.inFolder ? folderIconSize + FOLDER_HEADER_ICON_GAP : 0;
  const leadLeft = rowContentInset(sidebarPane) + folderIndent;
  const lineHeight = Math.max(20, labelTypography.lineHeight * fontScale);
  const label = item.expanded ? "Show less" : `+${item.count} ${item.kind}`;
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={
        item.expanded
          ? `Hide ${item.count} ${item.kind} threads`
          : `Show ${item.count} ${item.kind} ${item.count === 1 ? "thread" : "threads"}`
      }
      accessibilityState={{ expanded: item.expanded }}
      className={rowAppearance.className}
      interactionClassName={rowAppearance.interactionClassName}
      interactionOpacity={rowAppearance.interactionOpacity}
      onPress={() => props.onToggle(item.leadKey, item.kind)}
      style={rowAppearance.cardStyle}
    >
      <View
        style={{
          paddingLeft: leadLeft + THREAD_GROUP_INDENT - (sidebarPane ? 12 : 0),
          // The sidebar pill already pads the row.
          paddingVertical: sidebarPane ? 0 : ROW_CONTENT_PADDING_Y,
          justifyContent: "center",
          minHeight: lineHeight + (sidebarPane ? 0 : ROW_CONTENT_PADDING_Y * 2),
        }}
      >
        <Text
          className={cn("text-xs font-t3-medium", rowAppearance.tertiaryForegroundClassName)}
          numberOfLines={1}
        >
          {label}
        </Text>
      </View>
      <ThreadGroupTreeLine
        kind="last"
        color={theme[sidebarPane ? "--color-drawer-border" : "--color-border-subtle"]}
        leadLeft={leadLeft}
        branchY={ROW_CONTENT_PADDING_Y + lineHeight / 2}
        contentInset={0}
      />
    </RowPressable>
  );
});

export const ThreadListV2Row = memo(function ThreadListV2Row(props: {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  readonly hasQueuedMessages?: boolean;
  readonly snoozed?: boolean;
  readonly pinned?: boolean;
  readonly wokeAt: string | null;
  readonly workingSubagents?: number;
  readonly snoozeWakeLabelText?: string;
  readonly timeLabel: string;
  readonly snoozePresetMinute: string;
  readonly project: EnvironmentProject | null;
  /** Under the project's folder header, which already names the project. */
  readonly inFolder?: boolean;
  readonly providers: ReadonlyArray<ThreadListProvider> | undefined;
  readonly providerInstance: ThreadRowProviderInstance | null;
  readonly environmentLabel: string | null;
  readonly environmentMachine?: EnvironmentMachineKind;
  readonly pane?: "screen" | "sidebar";
  readonly showTrailingDivider?: boolean;
  readonly selected?: boolean;
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onOpenThreadPullRequests: (
    thread: EnvironmentThreadShell,
    pr: ThreadPrPresentation,
  ) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onRenameThread: (thread: EnvironmentThreadShell) => void;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (thread: EnvironmentThreadShell, snoozedUntil: string) => void;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onPinThread: (
    thread: EnvironmentThreadShell,
    options?: { readonly scope?: ThreadPinScope },
  ) => void;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => void;
  readonly onSetThreadAutoSettle: (thread: EnvironmentThreadShell, enabled: boolean) => void;
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly snoozePresets: ReadonlyArray<SnoozePresetSetting> | undefined;
  readonly pinningSupported: boolean;
  readonly autoSettleOptOutSupported: boolean;
  readonly titleRegenerationSupported: boolean;
  readonly reorderSupported?: boolean;
  readonly onMoveThread?: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => void;
  readonly canMoveUp?: boolean;
  readonly canMoveDown?: boolean;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly activationKey?: string;
  readonly searchMatch?: EnvironmentThreadSearchMatch;
  readonly searchQuery?: string;
  readonly simultaneousSwipeGesture?: ComponentProps<typeof ThreadSwipeable>["simultaneousWith"];
  readonly group?: ThreadListV2Item["group"];
  readonly groupRole?: ThreadListV2Item["groupRole"];
  readonly onToggleGroup?: (leadKey: string) => void;
  /** Opens the picker that attaches the thread to a group. */
  readonly onAttachThread?: (thread: EnvironmentThreadShell) => void;
  readonly onDetachThread?: (thread: EnvironmentThreadShell) => void;
  readonly onSettleGroup?: (
    lead: EnvironmentThreadShell,
    options: { readonly finishedOnly: boolean },
  ) => void;
}) {
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const titleTypography = useScaledTextRole("body");
  const metadataTypography = useScaledTextRole("label");
  const projectIconSize = titleTypography.fontSize * 1.25 * fontScale;
  const machineIconSize = metadataTypography.fontSize * fontScale;
  // Android's nonlinear system text scaling can differ from the fontScale estimate.
  const [androidTitleLineHeight, setTitleLineHeight] = useState(
    titleTypography.lineHeight * fontScale,
  );
  const titleLineHeight =
    Platform.OS === "android" ? androidTitleLineHeight : titleTypography.lineHeight * fontScale;
  const folderIconSize = useFolderHeaderIconSize();
  const { group, onToggleGroup, onAttachThread, onDetachThread, onSettleGroup } = props;
  const leadGroup = group?.role === "lead" ? group : null;
  const workerGroup = group?.role === "worker" ? group : null;
  const hasWorkers = leadGroup !== null || props.groupRole === "lead";
  const {
    thread,
    variant,
    onSelectThread,
    onOpenThreadPullRequests,
    onDeleteThread,
    onRenameThread,
    onRegenerateThreadTitle,
    onNewThreadOnBranch,
    onSettleThread,
    onSnoozeThread,
    onUnsnoozeThread,
    onUnsettleThread,
    onArchiveThread,
    onPinThread,
    onUnpinThread,
    onSetThreadAutoSettle,
    onMoveThread,
  } = props;
  const snoozedRow = props.snoozed === true;
  const pinnedRow = props.pinned === true;
  const dormant = useSwipeRowDormant(props.activationKey);

  const selectThread = () => onSelectThread(thread);
  const { providerDrivers, providerIconUrl } = useMemo(() => {
    const provider = props.providers?.find(
      (candidate) =>
        candidate.instanceId ===
        (thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId),
    );
    return {
      providerDrivers: resolveThreadListV2ProviderDrivers(thread, props.providers),
      providerIconUrl: provider?.iconUrl,
    };
  }, [thread, props.providers]);

  const providerInstance = props.providerInstance;
  const providerNameLabel = providerInstance
    ? providerInstanceNameLabel({
        provider: providerInstance.driverKind,
        iconUrl: providerIconUrl,
        displayName: providerInstance.displayName,
        showBadge: providerInstance.showBadge,
      })
    : null;
  const pr = useThreadPr(thread);
  const prBadgeLabel = pr ? resolveThreadPrBadgeAction(pr).accessibilityLabel : null;
  const handleOpenPullRequests = useCallback(() => {
    if (pr) onOpenThreadPullRequests(thread, pr);
  }, [onOpenThreadPullRequests, pr, thread]);

  const theme = useUniwindTheme();
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected === true;
  const rowAppearance = getThreadListV2RowAppearance(theme, sidebarPane, selected);

  const workingSubagents = props.workingSubagents ?? 0;
  const rawStatus = resolveThreadListV2Status(thread);
  const status = withWorkingSubagents(resolveThreadListV2RowStatus(thread), workingSubagents);
  const activity = resolveThreadActivityForDisplay({ activity: thread.activity, status });
  const activityPresentation = activity ? THREAD_ACTIVITY_PRESENTATION[activity.phase] : null;
  const isUnread = status === "ready" && threadHasUnseenCompletion(thread);
  const workingLabel = STATUS_LABEL_BY_STATUS[status];
  const showsWoke = status === "ready" && props.wokeAt !== null;
  const statusLabel =
    (status === "working" && workingLabel !== undefined && thread.goal?.status === "active"
      ? { ...workingLabel, label: "Goal" }
      : workingLabel) ?? (isUnread ? DONE_STATUS_LABEL : undefined);
  const recede = shouldRecedeThreadRow({ status, selected });
  // Slim rows are already muted; a card in a group shows a settled or snoozed member's state.
  const cardMemberState =
    variant === "card" ? (workerGroup?.memberState ?? leadGroup?.ownState ?? "live") : "live";
  const memberMuted = cardMemberState !== "live";
  const isRegeneratingTitle = thread.titleRegeneration != null;
  const timeLabel = props.timeLabel;
  const rowAccessibilityLabel = threadListV2RowAccessibilityLabel({
    title: thread.title,
    variant,
    woke: showsWoke,
    // Working and waiting rows show only an icon and a duration, so name them for speech.
    statusLabel:
      statusLabel && (statusLabel.label ?? (status === "waiting" ? "Waiting" : "Working")),
    timeLabel,
    snoozeWakeLabel: snoozedRow ? props.snoozeWakeLabelText : undefined,
    providerNameLabel,
    hasQueuedMessages: props.hasQueuedMessages === true,
    regeneratingTitle: isRegeneratingTitle,
  });

  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const markThreadUnread = useAtomCommand(threadEnvironment.markUnread, { reportFailure: false });
  const handleAcknowledgeWoke = useCallback(() => {
    if (props.wokeAt === null) return;
    void visitThread({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, visitedAt: props.wokeAt },
    });
  }, [props.wokeAt, thread.environmentId, thread.id, visitThread]);
  const handleToggleGroup = useCallback(
    () => onToggleGroup?.(`${thread.environmentId}:${thread.id}`),
    [onToggleGroup, thread.environmentId, thread.id],
  );
  // VoiceOver cannot focus buttons inside the accessible row.
  const rowAccessibilityActions = useMemo(
    () => [
      ...(prBadgeLabel ? [{ name: "openPullRequests", label: prBadgeLabel }] : []),
      ...(showsWoke ? [{ name: "dismissWoke", label: "Dismiss Woke notification" }] : []),
      ...(leadGroup
        ? [{ name: "toggleGroup", label: leadGroup.collapsed ? "Expand group" : "Collapse group" }]
        : []),
    ],
    [prBadgeLabel, showsWoke, leadGroup],
  );
  const handleRowAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === "openPullRequests") handleOpenPullRequests();
    if (event.nativeEvent.actionName === "dismissWoke") handleAcknowledgeWoke();
    if (event.nativeEvent.actionName === "toggleGroup") handleToggleGroup();
  };

  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleRename = useCallback(() => onRenameThread(thread), [onRenameThread, thread]);
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const handleRegenerateTitle = useCallback(
    () => onRegenerateThreadTitle(thread),
    [onRegenerateThreadTitle, thread],
  );
  const handleSettle = useCallback(() => onSettleThread(thread), [onSettleThread, thread]);
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  // Recycling changes identity without remounting; clear local UI directly because equality may skip the render closure.
  const rowIdentity = `${thread.environmentId}:${thread.id}`;
  const [boundIdentity, setBoundIdentity] = useState(rowIdentity);
  if (boundIdentity !== rowIdentity) {
    setBoundIdentity(rowIdentity);
    setCustomSnoozeOpen(false);
  }
  const handleSnooze = useCallback(
    (snoozedUntil: string) => onSnoozeThread(thread, snoozedUntil),
    [onSnoozeThread, thread],
  );
  const handleUnsnooze = useCallback(() => onUnsnoozeThread(thread), [onUnsnoozeThread, thread]);
  const handleUnsettle = useCallback(() => onUnsettleThread(thread), [onUnsettleThread, thread]);
  const handlePin = useCallback(() => onPinThread(thread), [onPinThread, thread]);
  const handlePinInProject = useCallback(
    () => onPinThread(thread, { scope: "project" }),
    [onPinThread, thread],
  );
  const handleUnpin = useCallback(() => onUnpinThread(thread), [onUnpinThread, thread]);
  const handleSetAutoSettle = useCallback(
    (enabled: boolean) => onSetThreadAutoSettle(thread, enabled),
    [onSetThreadAutoSettle, thread],
  );
  const handleMoveUp = useCallback(() => onMoveThread?.(thread, "up"), [onMoveThread, thread]);
  const handleMoveDown = useCallback(() => onMoveThread?.(thread, "down"), [onMoveThread, thread]);
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);
  const isWorker = workerGroup !== null || props.groupRole === "worker";
  const groupMenuItems = useMemo<MenuAction[]>(
    () =>
      isWorker
        ? onDetachThread
          ? [DETACH_MENU_ACTION]
          : []
        : onAttachThread
          ? [ATTACH_MENU_ACTION]
          : [],
    [isWorker, onAttachThread, onDetachThread],
  );
  const canSettleGroup = hasWorkers && onSettleGroup !== undefined;

  // A group's section follows its liveliest member, so a settled member can be a card.
  const ownSettled = (leadGroup?.ownState ?? workerGroup?.memberState) === "settled";
  const canUnsettle = variant === "slim" || ownSettled;
  // The gate's only time-dependent edge is the queued-turn grace window, so its
  // expiry is known without a clock: evaluate at the message's own timestamp.
  // A gate held by runtime status has no expiry, and no clock tick opens it.
  const snoozeGateExpiryMs = props.snoozeSupported
    ? resolveThreadListV2SnoozeGateExpiryMs(thread, { now: thread.latestUserMessageAt ?? "" })
    : null;
  // The window is inclusive, so wake just past it.
  const snoozeGateNowMs = useNowAfter(snoozeGateExpiryMs === null ? null : snoozeGateExpiryMs + 1);
  const snoozeGateNow = new Date(snoozeGateNowMs).toISOString();
  const swipeActions = resolveThreadListV2SwipeActions({
    variant,
    settled: ownSettled,
    settlementSupported: props.settlementSupported,
    snoozeSupported: props.snoozeSupported,
    snoozable: canSnooze(thread, { now: snoozeGateNow }),
    snoozed: snoozedRow,
  });
  const snoozePresets = resolveThreadListV2SnoozePresets({
    secondary: swipeActions.secondary,
    now: props.snoozePresetMinute || snoozeGateNow,
    presets: props.snoozePresets,
  });
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
  const reorderMenuItems = useMemo<MenuAction[]>(
    () =>
      props.reorderSupported === true
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
        : [],
    [props.canMoveDown, props.canMoveUp, props.reorderSupported],
  );
  const pinMenuItems = useMemo<MenuAction[]>(
    () =>
      props.pinningSupported
        ? thread.pinnedAt == null
          ? [
              { id: "pin", title: "Pin", image: "pin" },
              { id: "pin-project", title: "Pin in project", image: "pin" },
            ]
          : [
              // Unpin sits beside the other pin scope, so a pin moves between the two in one step.
              { id: "unpin", title: "Unpin", image: "pin.slash" },
              thread.pinScope === "project"
                ? { id: "pin", title: "Pin above projects", image: "pin" }
                : { id: "pin-project", title: "Pin in project", image: "pin" },
            ]
        : [],
    [props.pinningSupported, thread.pinnedAt, thread.pinScope],
  );
  const autoSettleMenuItems = useMemo<MenuAction[]>(
    () =>
      props.autoSettleOptOutSupported
        ? [
            {
              id: "auto-settle",
              title: "Auto-settle behavior",
              image: "timer",
              subactions: [
                {
                  id: "auto-settle:enabled",
                  title: "Follow settings",
                  state: thread.autoSettleDisabledAt == null ? "on" : "off",
                },
                {
                  id: "auto-settle:disabled",
                  title: "Never",
                  state: thread.autoSettleDisabledAt == null ? "off" : "on",
                },
              ],
            } satisfies MenuAction,
          ]
        : [],
    [props.autoSettleOptOutSupported, thread.autoSettleDisabledAt],
  );
  const canTurnIntoProject = canTurnThreadIntoProject(thread);
  const titleMenuItems = useMemo<MenuAction[]>(
    () => [
      { id: "rename", title: "Rename", image: "square.and.pencil" },
      ...buildThreadTitleRegenerationMenuItems({
        supported: props.titleRegenerationSupported,
        isRegenerating: isRegeneratingTitle,
      }),
      { id: "mark-unread", title: "Mark unread", image: "envelope.badge" },
      ...(canTurnIntoProject
        ? [
            {
              id: "turn-into-project",
              title: "Turn into project",
              image: "folder.badge.plus",
              attributes: { disabled: !threadCanArchive(thread.runtime) },
            } satisfies MenuAction,
          ]
        : []),
    ],
    [canTurnIntoProject, props.titleRegenerationSupported, thread.runtime, isRegeneratingTitle],
  );
  const menuActions = useMemo<MenuAction[]>(() => {
    const nested = Platform.OS === "ios";
    const direct: MenuAction[] = [
      ...(thread.branch
        ? [
            {
              id: "new-thread-on-branch",
              title: getThreadListV2NewBranchMenuTitle(thread.branch),
              image: "square.and.pencil",
            },
          ]
        : []),
      { id: "copy-thread", title: "Copy thread", image: "text.bubble" },
      { id: "copy-thread-id", title: "Copy thread ID", image: "doc.on.doc" },
    ];
    if (snoozedRow) {
      return layoutThreadListV2RowMenuActions({
        nested,
        direct: [...direct, SNOOZED_MENU_ACTIONS[0]!, ...groupMenuItems],
        reorder: [],
        pin: [],
        secondary: [
          ...titleMenuItems,
          ...autoSettleMenuItems,
          LEGACY_MENU_ACTIONS[0]!,
          SNOOZED_MENU_ACTIONS[1]!,
        ],
      });
    }
    if (!props.settlementSupported) {
      return layoutThreadListV2RowMenuActions({
        nested,
        direct: [...direct, LEGACY_MENU_ACTIONS[0]!, ...groupMenuItems],
        reorder: reorderMenuItems,
        pin: isWorker ? [] : pinMenuItems,
        secondary: [...titleMenuItems, LEGACY_MENU_ACTIONS[1]!],
      });
    }
    if (canUnsettle) {
      return layoutThreadListV2RowMenuActions({
        nested,
        direct: [...direct, SLIM_MENU_ACTIONS[0]!, ...groupMenuItems],
        reorder: reorderMenuItems.filter(
          (action) => action.id !== "move-up" && action.id !== "move-down",
        ),
        pin: isWorker ? [] : pinMenuItems,
        secondary: [
          ...titleMenuItems,
          ...autoSettleMenuItems,
          LEGACY_MENU_ACTIONS[0]!,
          SLIM_MENU_ACTIONS[1]!,
        ],
      });
    }
    return layoutThreadListV2RowMenuActions({
      nested,
      direct: [
        ...direct,
        canSettleGroup ? SETTLE_GROUP_MENU_ACTION : CARD_MENU_ACTIONS[0]!,
        ...(swipeActions.secondary === "snooze"
          ? [
              {
                id: "snooze",
                title: hasWorkers ? "Snooze group" : "Snooze",
                image: "clock",
                subactions: snoozePresetActions,
              },
            ]
          : []),
        ...groupMenuItems,
      ],
      reorder: reorderMenuItems,
      pin: isWorker ? [] : pinMenuItems,
      secondary: [
        ...titleMenuItems,
        ...autoSettleMenuItems,
        LEGACY_MENU_ACTIONS[0]!,
        CARD_MENU_ACTIONS[1]!,
      ],
    });
  }, [
    autoSettleMenuItems,
    canSettleGroup,
    canUnsettle,
    groupMenuItems,
    hasWorkers,
    isWorker,
    pinMenuItems,
    props.settlementSupported,
    reorderMenuItems,
    snoozePresetActions,
    snoozedRow,
    swipeActions.secondary,
    thread.branch,
    titleMenuItems,
  ]);
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "new-thread-on-branch") onNewThreadOnBranch(thread);
      if (nativeEvent.event === "settle") handleSettle();
      if (nativeEvent.event === "attach") onAttachThread?.(thread);
      if (nativeEvent.event === "detach") onDetachThread?.(thread);
      if (nativeEvent.event === "settle-group") onSettleGroup?.(thread, { finishedOnly: false });
      if (nativeEvent.event === "settle-group-finished") {
        onSettleGroup?.(thread, { finishedOnly: true });
      }
      if (nativeEvent.event === "unsettle") handleUnsettle();
      if (nativeEvent.event === "unsnooze") handleUnsnooze();
      if (nativeEvent.event === "pin") handlePin();
      if (nativeEvent.event === "pin-project") handlePinInProject();
      if (nativeEvent.event === "unpin") handleUnpin();
      if (nativeEvent.event === "auto-settle:enabled") handleSetAutoSettle(true);
      if (nativeEvent.event === "auto-settle:disabled") handleSetAutoSettle(false);
      if (nativeEvent.event === "arrange") appAtomRegistry.set(threadArrangementOpenAtom, true);
      if (nativeEvent.event === "move-up") handleMoveUp();
      if (nativeEvent.event === "move-down") handleMoveDown();
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "rename") handleRename();
      if (nativeEvent.event === "regenerate-title") handleRegenerateTitle();
      if (nativeEvent.event === "turn-into-project") void turnThreadIntoProject(thread);
      if (nativeEvent.event === "mark-unread") {
        void markThreadUnread({
          environmentId: thread.environmentId,
          input: { threadId: thread.id },
        });
      }
      if (nativeEvent.event === "copy-thread") {
        const target = threadChipCopyTarget(
          { environmentId: thread.environmentId, threadId: thread.id },
          thread.title,
        );
        void copyThreadReference(target).then((didCopy) => {
          if (!didCopy) Dialog.alert(target.failureTitle, "Try copying this thread again.");
        });
      }
      if (nativeEvent.event === "copy-thread-id") {
        copyTextWithHaptic(thread.id, { target: "thread-id" });
      }
      if (nativeEvent.event === "delete") handleDelete();
      if (nativeEvent.event === "snooze:custom") {
        setCustomSnoozeOpen(true);
        return;
      }
      const snoozeSelection = resolveThreadListV2SnoozeMenuSelection({
        event: nativeEvent.event,
        displayedPresets: snoozePresets,
        now: new Date(),
        presets: props.snoozePresets,
      });
      if (snoozeSelection._tag === "selected") {
        handleSnooze(snoozeSelection.preset.snoozedUntil);
      } else if (snoozeSelection._tag === "expired") {
        Dialog.alert(
          "Could not snooze thread",
          "That snooze time has passed. Choose another time.",
        );
      }
    },
    [
      onAttachThread,
      onDetachThread,
      onSettleGroup,
      onNewThreadOnBranch,
      thread,
      handleArchive,
      handleDelete,
      handleRegenerateTitle,
      handleRename,
      handleMoveDown,
      handleMoveUp,
      handlePin,
      handlePinInProject,
      handleSettle,
      handleSnooze,
      handleSetAutoSettle,
      handleUnpin,
      handleUnsettle,
      handleUnsnooze,
      markThreadUnread,
      setCustomSnoozeOpen,
      snoozePresets,
      props.snoozePresets,
    ],
  );
  const primaryAction = useMemo(() => {
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
  const swipeAccessibilityHint = !canOperateThread
    ? "Opens the thread"
    : secondaryAction === null
      ? `Opens the thread. Swipe left to ${primaryAction.label.toLowerCase()}.`
      : `Opens the thread. Swipe left for ${primaryAction.label.toLowerCase()} and snooze actions.`;

  // The folder header carries the project's icon and name; its rows indent under that name.
  const projectLine = props.inFolder ? null : props.project;
  const folderIndent = props.inFolder ? folderIconSize + FOLDER_HEADER_ICON_GAP : 0;
  const titleTextInset = projectLine ? projectIconSize + 8 : 0;
  const threadTitle = (
    <Text
      className={cn(
        "flex-1 text-base",
        !recede && "font-t3-medium",
        selected ? selectedThreadRowColors.foregroundClassName : rowAppearance.foregroundClassName,
        (isRegeneratingTitle || memberMuted) && "opacity-55",
      )}
      numberOfLines={2}
      onTextLayout={
        Platform.OS === "android"
          ? ({ nativeEvent }) => {
              const firstLine = nativeEvent.lines[0];
              if (firstLine && Math.abs(firstLine.height - titleLineHeight) > 0.5) {
                setTitleLineHeight(firstLine.height);
              }
            }
          : undefined
      }
    >
      {thread.title}
    </Text>
  );
  const groupChip = leadGroup ? (
    <ThreadGroupChip
      group={leadGroup}
      selected={selected}
      tertiaryClassName={rowAppearance.tertiaryForegroundClassName}
      tertiaryTintClassName={rowAppearance.tertiaryIconTintClassName}
      onToggle={handleToggleGroup}
    />
  ) : null;
  const hasTrailingDivider =
    !sidebarPane && THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider !== false;
  const groupLineColor = theme[sidebarPane ? "--color-drawer-border" : "--color-border-subtle"];
  const groupLeft = rowContentInset(sidebarPane) + (variant === "card" ? folderIndent : 0);
  const slimTitleY =
    providerNameLabel || props.searchMatch
      ? 8 + titleLineHeight / 2
      : Math.max(22, 8 + titleLineHeight / 2);
  const treeLine = workerGroup ? (
    <ThreadGroupTreeLine
      kind={workerGroup.isLastInGroup ? "last" : "worker"}
      color={groupLineColor}
      leadLeft={groupLeft}
      branchY={
        variant === "card"
          ? ROW_CONTENT_PADDING_Y + (projectLine ? titleLineHeight : 0) + titleLineHeight / 2
          : projectLine
            ? 8 + titleLineHeight * 1.5
            : slimTitleY
      }
      contentInset={titleTextInset}
    />
  ) : leadGroup && !leadGroup.collapsed ? (
    <ThreadGroupTreeLine
      kind="lead"
      color={groupLineColor}
      leadLeft={groupLeft}
      stubHeight={variant === "card" ? ROW_CONTENT_PADDING_Y + (hasTrailingDivider ? 1 : 0) : 8}
    />
  ) : null;
  const cardContent = (
    <>
      <View className="flex-row items-start gap-2">
        {projectLine ? (
          <ThreadListV2ProjectLine
            environmentId={thread.environmentId}
            project={projectLine}
            iconSize={projectIconSize}
            lineHeight={titleLineHeight}
            selected={selected}
          />
        ) : (
          threadTitle
        )}
        <View
          className="flex-row items-center gap-1.5"
          style={{
            minHeight: titleLineHeight,
            opacity: workerGroup !== null && memberMuted ? 0.55 : 1,
          }}
        >
          {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
          {pinnedRow ? (
            <SymbolView
              name="pin"
              size={11}
              tintColorClassName={rowAppearance.mutedIconTintClassName}
              type="monochrome"
            />
          ) : null}
          {memberMuted ? (
            <SymbolView
              name={cardMemberState === "settled" ? "checkmark" : "clock"}
              size={11}
              tintColorClassName={
                selected
                  ? selectedThreadRowColors.mutedIconTintClassName
                  : rowAppearance.mutedIconTintClassName
              }
              type="monochrome"
              weight="semibold"
            />
          ) : null}
          {showsWoke ? (
            <Pressable
              className="-m-2.5 flex-row items-center gap-1 p-2.5"
              accessibilityRole="button"
              accessibilityLabel="Dismiss Woke notification"
              onPress={handleAcknowledgeWoke}
              onLongPress={() => undefined}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <SymbolView
                name="bell.badge"
                size={13}
                tintColorClassName={
                  selected ? selectedThreadRowColors.iconTintClassName : "accent-warning-foreground"
                }
                type="monochrome"
                weight="semibold"
              />
              <Text
                className={cn(
                  "text-xs font-t3-bold",
                  selected
                    ? selectedThreadRowColors.foregroundClassName
                    : "text-warning-foreground",
                )}
              >
                Woke
              </Text>
            </Pressable>
          ) : statusLabel ? (
            <View className="flex-row items-center gap-1">
              {activity ? null : (
                <SymbolView
                  name={statusLabel.icon}
                  size={13}
                  tintColorClassName={
                    selected
                      ? selectedThreadRowColors.iconTintClassName
                      : statusLabel.iconTintClassName
                  }
                  type="monochrome"
                  weight="semibold"
                />
              )}
              <Text
                className={cn(
                  "text-xs font-t3-bold",
                  selected ? selectedThreadRowColors.foregroundClassName : statusLabel.className,
                )}
              >
                {activity ? null : statusLabel.label}
                {status === "working" ? (
                  <ThreadListV2Duration
                    environmentId={thread.environmentId}
                    startedAt={
                      resolveThreadWorkingStartedAt(thread) ??
                      (workingSubagents > 0 ? (thread.latestRun?.startedAt ?? null) : null)
                    }
                    leadingSpace={statusLabel.label !== null}
                  />
                ) : status === "waiting" ? (
                  <ThreadListV2Duration
                    environmentId={thread.environmentId}
                    startedAt={thread.latestRun?.completedAt ?? null}
                    leadingSpace={statusLabel.label !== null}
                  />
                ) : null}
              </Text>
              {status === "working" && workingSubagents > 0 ? (
                <View
                  accessibilityLabel={`${workingSubagents} subagents working`}
                  className="flex-row items-center gap-0.5"
                >
                  <SymbolView
                    name="person.2"
                    size={11}
                    tintColorClassName={
                      selected
                        ? selectedThreadRowColors.iconTintClassName
                        : statusLabel.iconTintClassName
                    }
                    type="monochrome"
                  />
                  <Text
                    className={cn(
                      "text-xs font-t3-bold tabular-nums",
                      selected
                        ? selectedThreadRowColors.foregroundClassName
                        : statusLabel.className,
                    )}
                  >
                    ×{workingSubagents}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : workerGroup !== null && cardMemberState === "settled" ? null : (
            <Text
              className={cn(
                "text-xs tabular-nums",
                selected
                  ? selectedThreadRowColors.foregroundClassName
                  : rowAppearance.tertiaryForegroundClassName,
              )}
            >
              {workerGroup !== null &&
              cardMemberState === "snoozed" &&
              props.snoozeWakeLabelText !== undefined
                ? props.snoozeWakeLabelText
                : timeLabel}
            </Text>
          )}
        </View>
      </View>
      {projectLine ? (
        <View className="flex-row" style={{ paddingLeft: titleTextInset }}>
          {threadTitle}
        </View>
      ) : null}
      {props.searchMatch ? (
        <View className="mt-1" style={{ paddingLeft: titleTextInset }}>
          <ThreadSearchMatchExcerpt
            sidebar={sidebarPane}
            match={props.searchMatch}
            query={props.searchQuery ?? ""}
            selected={selected}
          />
        </View>
      ) : null}
      <View className="mt-1 flex-row items-center gap-2" style={{ paddingLeft: titleTextInset }}>
        {(rawStatus === "failed" || rawStatus === "limited") && thread.runtime?.lastError ? (
          <Text
            className={cn(
              "flex-1 text-xs",
              selected
                ? selectedThreadRowColors.mutedForegroundClassName
                : status === "limited"
                  ? "text-warning-foreground"
                  : "text-danger-foreground",
            )}
            numberOfLines={1}
          >
            {thread.runtime.lastError}
          </Text>
        ) : activity && activityPresentation ? (
          <View className="min-w-0 flex-1 flex-row items-center gap-1">
            <SymbolView
              name={activityPresentation.icon}
              size={12}
              tintColorClassName={
                selected
                  ? selectedThreadRowColors.iconTintClassName
                  : activityPresentation.iconTintClassName
              }
              type="monochrome"
              weight="semibold"
            />
            <Text
              className={cn(
                "text-xs font-t3-bold",
                selected
                  ? selectedThreadRowColors.foregroundClassName
                  : activityPresentation.textClassName,
              )}
            >
              {THREAD_ACTIVITY_PHASE_LABEL[activity.phase]}
            </Text>
            <Text
              className={cn(
                "shrink text-xs",
                selected
                  ? selectedThreadRowColors.foregroundClassName
                  : rowAppearance.foregroundClassName,
              )}
              numberOfLines={1}
            >
              {` · ${activity.label}`}
            </Text>
          </View>
        ) : props.environmentLabel ? (
          <View className="min-w-0 flex-1 flex-row items-center gap-1">
            {props.environmentMachine ? (
              <EnvironmentMachineSymbol
                kind={props.environmentMachine}
                size={machineIconSize}
                tintColorClassName={
                  selected
                    ? selectedThreadRowColors.mutedIconTintClassName
                    : rowAppearance.tertiaryIconTintClassName
                }
              />
            ) : null}
            <Text
              className={cn(
                "shrink text-xs",
                selected
                  ? selectedThreadRowColors.mutedForegroundClassName
                  : rowAppearance.tertiaryForegroundClassName,
              )}
              numberOfLines={1}
            >
              {props.environmentLabel}
            </Text>
          </View>
        ) : (
          <View className="flex-1" />
        )}
        {pr ? (
          <Pressable
            // Padding cancelled by negative margin grows the touch target into
            // the row padding without moving the badge.
            className="-m-2.5 flex-row items-center gap-1 p-2.5"
            accessibilityRole="button"
            accessibilityLabel={prBadgeLabel ?? undefined}
            onPress={handleOpenPullRequests}
            // Handle long-press so opening the iOS row menu cannot also open the PR on release.
            onLongPress={() => undefined}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <SymbolView
              name={
                pr.kind === "stack"
                  ? PullRequestGlyph.stack
                  : pr.state === null
                    ? PullRequestGlyph.pullRequest
                    : pullRequestStatus({ state: pr.state, isDraft: pr.isDraft }).icon
              }
              size={12}
              tintColorClassName={
                pr.state === null || pr.isDraft
                  ? rowAppearance.mutedIconTintClassName
                  : pr.state === "open"
                    ? "accent-adaptive-emerald-600-400"
                    : pr.state === "closed"
                      ? "accent-adaptive-rose-600-400"
                      : "accent-adaptive-violet-600-400"
              }
            />
            <Text
              accessibilityLabel={pr.accessibilityLabel}
              className={cn("text-xs", pr.textClassName)}
              style={{ fontFamily: MONO_FONT }}
            >
              {pr.label}
            </Text>
          </Pressable>
        ) : null}
        {providerInstance ? (
          <View className="flex-row items-center">
            {providerDrivers.slice(0, -1).map(
              (driver, index) => (
                /* oxlint-disable react/no-array-index-key -- Provider history can repeat a driver; these decorative icons have no local state. */ <View
                  key={`${driver}:${index}`}
                  className="-mr-1 opacity-30"
                >
                  <ProviderIcon provider={driver} size={12} />
                </View>
              ) /* oxlint-enable react/no-array-index-key */,
            )}
            <ProviderInstanceIcon
              iconUrl={providerIconUrl}
              provider={providerInstance.driverKind}
              size={14}
              displayName={providerInstance.displayName}
              accentColor={providerInstance.accentColor}
              showBadge={providerInstance.showBadge}
              surfaceColor={rowAppearance.providerIconSurfaceColor}
            />
            {providerNameLabel ? (
              <Text
                className={cn(
                  "ml-1.5 text-xs",
                  selected
                    ? selectedThreadRowColors.mutedForegroundClassName
                    : rowAppearance.tertiaryForegroundClassName,
                )}
                ellipsizeMode="middle"
                numberOfLines={1}
                style={{ maxWidth: 140 }}
              >
                {providerNameLabel}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
      {leadGroup ? <View style={{ paddingLeft: titleTextInset }}>{groupChip}</View> : null}
    </>
  );

  const contentIndent = folderIndent + (workerGroup ? THREAD_GROUP_INDENT : 0);
  const fadedCardContent =
    recede || contentIndent > 0 ? (
      <View style={{ opacity: recede ? 0.55 : 1, paddingLeft: contentIndent }}>{cardContent}</View>
    ) : (
      cardContent
    );

  const slimDetails = (
    <View className="min-w-0 flex-1">
      <Text
        className={cn(
          "text-base",
          selected
            ? selectedThreadRowColors.foregroundClassName
            : rowAppearance.mutedForegroundClassName,
          isRegeneratingTitle && "opacity-55",
        )}
        numberOfLines={1}
      >
        {thread.title}
      </Text>
      {providerNameLabel ? (
        <Text
          className={cn(
            "text-xs",
            selected
              ? selectedThreadRowColors.mutedForegroundClassName
              : rowAppearance.tertiaryForegroundClassName,
          )}
          ellipsizeMode="middle"
          numberOfLines={1}
        >
          {providerNameLabel}
        </Text>
      ) : null}
      {props.searchMatch ? (
        <ThreadSearchMatchExcerpt
          sidebar={sidebarPane}
          match={props.searchMatch}
          query={props.searchQuery ?? ""}
          selected={selected}
        />
      ) : null}
      {groupChip}
    </View>
  );
  const slimTrailing = (
    <>
      {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
      <Text
        className={cn(
          "text-sm tabular-nums",
          selected
            ? selectedThreadRowColors.mutedForegroundClassName
            : snoozedRow
              ? rowAppearance.mutedForegroundClassName
              : rowAppearance.tertiaryForegroundClassName,
        )}
        style={{ fontFamily: MONO_FONT }}
      >
        {snoozedRow && props.snoozeWakeLabelText !== undefined
          ? props.snoozeWakeLabelText
          : timeLabel}
      </Text>
    </>
  );

  const slimWorkerInsetStyle = workerGroup
    ? { paddingLeft: groupLeft + THREAD_GROUP_INDENT }
    : undefined;

  const rowContent = (close: () => void) =>
    variant === "card" ? (
      <RowPressable
        key={`${thread.environmentId}:${thread.id}`}
        interactionClassName={rowAppearance.interactionClassName}
        interactionOpacity={rowAppearance.interactionOpacity}
        className={rowAppearance.className}
        accessibilityHint={swipeAccessibilityHint}
        accessibilityLabel={rowAccessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityActions={rowAccessibilityActions}
        onAccessibilityAction={handleRowAccessibilityAction}
        onPress={() => {
          close();
          selectThread();
        }}
        style={rowAppearance.cardStyle}
      >
        {sidebarPane ? (
          <>
            {fadedCardContent}
            {treeLine}
          </>
        ) : (
          <View>
            <View className={THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME}>{fadedCardContent}</View>
            {hasTrailingDivider ? (
              <View
                className="h-px bg-border-subtle"
                // An open lead's divider starts past the tree trunk, in line with its workers'.
                style={{
                  marginLeft:
                    20 +
                    contentIndent +
                    (leadGroup && !leadGroup.collapsed && leadGroup.workerCount > 0
                      ? THREAD_GROUP_INDENT
                      : 0),
                }}
              />
            ) : null}
            {treeLine}
          </View>
        )}
      </RowPressable>
    ) : (
      <RowPressable
        key={`${thread.environmentId}:${thread.id}`}
        interactionClassName={rowAppearance.interactionClassName}
        interactionOpacity={rowAppearance.interactionOpacity}
        accessibilityHint={swipeAccessibilityHint}
        accessibilityLabel={rowAccessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityActions={rowAccessibilityActions}
        onAccessibilityAction={handleRowAccessibilityAction}
        className={rowAppearance.className}
        onPress={() => {
          close();
          selectThread();
        }}
        style={rowAppearance.style}
      >
        {projectLine ? (
          <View
            className={cn(
              THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
              "min-h-[44px] py-2",
              sidebarPane && "px-3",
            )}
            style={slimWorkerInsetStyle}
          >
            <View className="flex-row items-center gap-2">
              <ThreadListV2ProjectLine
                environmentId={thread.environmentId}
                project={projectLine}
                iconSize={projectIconSize}
                lineHeight={titleLineHeight}
                selected={selected}
                muted
              />
              {slimTrailing}
            </View>
            <View className="flex-row" style={{ paddingLeft: titleTextInset }}>
              {slimDetails}
            </View>
          </View>
        ) : (
          <View
            className={cn(
              THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
              "min-h-[44px] flex-row items-center gap-2 py-2",
              sidebarPane && "px-3",
            )}
            style={slimWorkerInsetStyle}
          >
            {slimDetails}
            {slimTrailing}
          </View>
        )}
        {treeLine}
      </RowPressable>
    );

  if (!canOperateThread)
    return <View style={rowAppearance.swipeContainerStyle}>{rowContent(() => {})}</View>;

  return (
    <View collapsable={false}>
      {customSnoozeOpen && (
        <CustomSnoozeSheet onClose={() => setCustomSnoozeOpen(false)} onSnooze={handleSnooze} />
      )}
      <ThreadSwipeable
        dormant={dormant}
        threadKey={`${thread.environmentId}:${thread.id}`}
        backgroundColor={rowAppearance.swipeBackgroundColor}
        compactActions={variant === "slim"}
        containerStyle={rowAppearance.swipeContainerStyle}
        enableTrackpadSwipe
        fullSwipeAction="primary"
        fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
        listAnimatesLayout
        onDelete={handleDelete}
        onSwipeableClose={props.onSwipeableClose}
        onSwipeableWillOpen={props.onSwipeableWillOpen}
        primaryAction={primaryAction}
        secondaryAction={secondaryAction}
        resetKey={`${thread.environmentId}:${thread.id}:${variant}:${snoozedRow}:${thread.settledAt}:${thread.unsettledAt}:${thread.snoozedUntil}:${thread.pinnedAt}`}
        simultaneousWith={props.simultaneousSwipeGesture}
        threadTitle={thread.title}
      >
        {(close) => (
          <Menu
            title={activity ? formatThreadActivity(activity) : undefined}
            accessibilityLabel={rowAccessibilityLabel}
            actions={menuActions}
            onPressAction={handleMenuAction}
            shouldOpenOnLongPress
          >
            {rowContent(close)}
          </Menu>
        )}
      </ThreadSwipeable>
    </View>
  );
});
