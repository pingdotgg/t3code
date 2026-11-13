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
import { AuthOrchestrationOperateScope, type EnvironmentMachineKind } from "@t3tools/contracts";
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import type { MenuAction } from "@react-native-menu/menu";
import { memo, useCallback, useMemo, useState, type ComponentProps } from "react";
import { Platform, Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import type { ThreadListProvider } from "../../state/thread-list-environments";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ProviderIcon, ProviderInstanceIcon } from "../../components/ProviderIcon";
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
  resolveThreadListV2Status,
  resolveThreadListV2ProviderDrivers,
  resolveThreadListV2SwipeActions,
  type ThreadListV2Status,
} from "./threadListV2";
import { QueuedMessageIcon } from "./queued-message-icon";
import { shouldRecedeThreadRow } from "./thread-row-emphasis";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { pullRequestStatus } from "../pull-requests/pullRequestStatus";
import { DRAFT_TASK_MENU_ACTIONS, PENDING_TASK_MENU_ACTIONS, ThreadListV2SectionDivider } from "./thread-list-v2-items";

export const ThreadListV2PendingRow = memo(function ThreadListV2PendingRow(props: {
  readonly pendingTask: PendingNewTask;
  readonly selected?: boolean;
  readonly project: EnvironmentProject | null;
  readonly projectTitle?: string;
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
  const projectTitle = props.projectTitle ?? props.project?.title ?? pendingTask.projectTitle ?? "";
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
  const rowContent = (
    <>
      <View className="flex-row items-start gap-2">
        {props.project ? (
          <View className="justify-center" style={{ height: titleLineHeight }}>
            <ProjectFavicon
              environmentId={pendingTask.environmentId}
              faviconPath={props.project.faviconPath}
              projectIcon={props.project.projectIcon}
              size={projectIconSize}
              projectTitle={projectTitle}
              workspaceRoot={props.project.workspaceRoot}
            />
          </View>
        ) : null}
        <Text
          className={cn(
            "flex-1 text-base font-t3-medium",
            selected
              ? selectedThreadRowColors.foregroundClassName
              : rowAppearance.foregroundClassName,
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

