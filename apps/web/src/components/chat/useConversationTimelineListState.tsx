import { AudioPreviewUnmountContext } from "../files/AudioPreview";
import { useChatCanvas } from "./ChatCanvasContext";
import { WorkLogBlock } from "./WorkLog";
import { TimelinePendingApprovalRow } from "./TimelinePendingApprovalRow";
import { useStableCallback } from "~/hooks/useStableCallback";
import { type SyntheticEvent } from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { BotIcon, MessagesSquareIcon } from "lucide-react";
import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import { useThreadFindNavigation } from "./useThreadFindNavigation";
import { TimelineSystemDivider } from "./TimelineSystemDivider";
import { forwardWheelToTimeline } from "./timelineMinimapWheel";
import { type TimelineRowSharedState, type TimelineRowActivityState, TimelineRowCtx } from "./timelineRowContext";
import { attachTimelineViewport } from "./timelineViewport";
import { useThreadFindPositionReader } from "./useThreadFindPositionReader";
import { ThreadActivityAnnouncer } from "./ThreadActivityAnnouncer";
import { CITED_HISTORY_LOADING, EMPTY_PENDING_APPROVALS, EMPTY_RESPONDING_REQUEST_IDS, EMPTY_RUN_IDS, EMPTY_TIMELINE_SKILLS, NOOP_OPEN_ATTACHMENT, NOOP_USE_ARTIFACT_TEMPLATE, TIMELINE_LIST_FADE_HEADER, TIMELINE_LIST_HEADER, TimelineHistoryControl, TimelineListFooter, TimelineRowContent } from "./messagesTimelineShared";
import type { MessagesTimelineProps } from "./messagesTimelineShared";
import type { useConversationTimelineRows } from "./useConversationTimelineRows";
import type { useConversationTimelineViewport } from "./useConversationTimelineViewport";

export function useConversationTimelineListState(
  input: MessagesTimelineProps & ReturnType<typeof useConversationTimelineRows> & ReturnType<typeof useConversationTimelineViewport>,
) {
  const {
    anchoredEndSpace,
    citationThreadRef,
    findActive,
    findFoldRunIds,
    findListReady,
    handleContentSizeChanged,
    isVisiblePendingApproval,
    listIdentityKey,
    minimapRefreshFrameRef,
    navigateTimeline,
    normalizedFindQuery,
    observeLaneWidth,
    onAppFullscreenChange,
    onToggleAttemptFold,
    onToggleTurnFold,
    onToggleWorkGroup,
    openPullRequest,
    readyCitationRequest,
    rememberReleasedPosition,
    restoringThreadPosition,
    rows,
    runs,
    setPlayingAudioRows,
    suspendEndScrollMaintenanceForDisclosure,
    timelineViewportElement,
    unmatchedPendingApprovals,
    viewportRef,
    workGroupViewState,
  } = input;
  const {
  pendingApprovals = EMPTY_PENDING_APPROVALS,
  heldApprovalRequestIds,
  respondingRequestIds = EMPTY_RESPONDING_REQUEST_IDS,
  canOperateThread = false,
  onRespondToApproval,
  citationRequest = null,
  citationHistory = CITED_HISTORY_LOADING,
  onCiteAssistantText,
  isWorking,
  runlessWorkActive = false,
  activeTurnStartedAt = null,
  worktreeSetup = null,
  footer = null,
  onCancelWorktreeSetup,
  retryableWorkspacePreparationRunIds = EMPTY_RUN_IDS,
  onRetryWorkspacePreparation,
  onWorktreeSetupWorkLocally,
  onOpenWorktreeSetupTerminal,
  isPreparingWorktree = false,
  isCompacting = false,
  awaitingUser = null,
  awaitingRequestId = null,
  listRef,
  timelineEntries,
  findOpen = false,
  findExpanded = false,
  findQuery = "",
  activeFindMatch = null,
  findNavigationId = 0,
  latestRun,
  announcedRun = null,
  detailBehindShell = false,
  runningRunId = null,
  turnDiffSummaries,
  routeThreadKey,
  displayThreadKey,
  announceTurnStatus = true,
  onOpenToolDiff,
  onOpenTurnDiff,
  onOpenThread,
  renderHtmlRender,
  turnItemSource,
  parentThreadLink = null,
  workflowOpening = null,
  onForkFromRun,
  supportsConversationRollback,
  threadStartCheckpointReady = false,
  availableRevertTurnCounts,
  onRevertToTurnCount,
  onUseArtifactTemplate = NOOP_USE_ARTIFACT_TEMPLATE,
  onSendAppMessage,
  onRunShellCommand,
  isRevertingCheckpoint,
  onImageExpand,
  onFileOpen = NOOP_OPEN_ATTACHMENT,
  onFileDownload = NOOP_OPEN_ATTACHMENT,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  runs: runsProp,
  anchorMessageId,
  onAnchorReady,
  onAnchorSizeChanged,
  contentInsetEndAdjustment,
  onIsAtEndChange,
  liveFollowEnabled,
  onViewportAttach,
  onFooterGrow,
  hideEmptyPlaceholder = false,
  emptyPlaceholderInset,
  topFadeEnabled = false,
  historyControls,
  } = input;
  const pendingApprovalsByRequestId = new Map(
    pendingApprovals
      .filter(isVisiblePendingApproval)
      .map((approval) => [approval.requestId, approval]),
  );
  const sharedState: TimelineRowSharedState = {
    pendingApprovals: pendingApprovalsByRequestId,
    respondingRequestIds,
    canOperateThread,
    onRespondToApproval,
    citationRequest: readyCitationRequest,
    listRef,
    timestampFormat,
    routeThreadKey,
    threadRef: citationThreadRef,
    markdownCwd,
    resolvedTheme,
    workspaceRoot,
    skills,
    runs,
    activeThreadEnvironmentId,
    onRevertToTurnCount,
    onRunShellCommand,
    findActive,
    onImageExpand,
    onFileOpen,
    onUseArtifactTemplate,
    onSendAppMessage,
    onAppFullscreenChange,
    onFileDownload,
    openPullRequest,
    onOpenToolDiff,
    onOpenTurnDiff,
    onOpenThread,
    renderHtmlRender,
    turnItemSource,
    workflowOpening,
    onForkFromRun,
    onToggleTurnFold,
    onToggleAttemptFold,
    onToggleWorkGroup,
    onToggleWorkEntry: suspendEndScrollMaintenanceForDisclosure,
    onCancelWorktreeSetup: onCancelWorktreeSetup ?? null,
    retryableWorkspacePreparationRunIds,
    onRetryWorkspacePreparation: onRetryWorkspacePreparation ?? null,
    onWorktreeSetupWorkLocally: onWorktreeSetupWorkLocally ?? null,
    onOpenWorktreeSetupTerminal: onOpenWorktreeSetupTerminal ?? null,
    workGroupViewState,
  };
  const compactionAwaitingRow =
    isCompacting &&
    !rows.some(
      (row) =>
        (row.kind === "context-compaction" && row.active) ||
        (row.kind === "working" && row.compacting),
    );
  const backgroundWorktreeSetup =
    worktreeSetup !== null &&
    worktreeSetup.phase === "running" &&
    worktreeSetupAgentStarted(worktreeSetup) &&
    latestRun?.startedAt != null
      ? worktreeSetup
      : null;
  const activityState: TimelineRowActivityState = {
    isWorking,
    isCompacting: compactionAwaitingRow,
    isRevertingCheckpoint,
    backgroundWorktreeSetup,
    awaitingUser: awaitingUser !== null,
    isPreparingWorktree,
    latestRunId: latestRun?.runId ?? null,
  };
  // Mounted in both the empty and filled timeline so a thread's first turn
  // starts from a baseline instead of a fresh, silent region.
  const activityAnnouncer = (
    <ThreadActivityAnnouncer
      threadKey={announceTurnStatus ? listIdentityKey : null}
      status={awaitingUser ?? (isWorking ? "working" : "idle")}
      requestId={awaitingRequestId}
      runId={announcedRun?.runId ?? null}
      runStatus={announcedRun?.status ?? null}
      detailBehind={detailBehindShell}
    />
  );
  const listHeaderLeadingContent =
    parentThreadLink === null ? (
      topFadeEnabled ? (
        TIMELINE_LIST_FADE_HEADER
      ) : (
        TIMELINE_LIST_HEADER
      )
    ) : (
      <div className="messages-timeline-row-frame">
        <div className="chat-content-lane pt-1 sm:pt-2">
          <TimelineSystemDivider
            label={parentThreadLink.sideChat ? "Context from" : "Subagent of"}
            detail={
              parentThreadLink.environmentLabel === undefined
                ? parentThreadLink.title
                : `${parentThreadLink.title} on ${parentThreadLink.environmentLabel}`
            }
            icon={parentThreadLink.sideChat ? MessagesSquareIcon : BotIcon}
            {...(parentThreadLink.open === undefined
              ? {}
              : { actionLabel: "Open parent thread", onAction: parentThreadLink.open })}
          />
        </div>
      </div>
    );
  const listHeader = (
    <>
      {parentThreadLink === null ? listHeaderLeadingContent : null}
      {historyControls ? <TimelineHistoryControl {...historyControls} /> : null}
      {parentThreadLink !== null ? listHeaderLeadingContent : null}
    </>
  );

  const canvas = useChatCanvas();
  const registerTimeline = canvas?.registerTimeline;
  // Stable so the list attaches once per mount, not on every render.
  const setTimelineList = useStableCallback((list: LegendListRef | null) => {
    listRef.current = list;
    const scrollNode: HTMLElement | null = list?.getScrollableNode() ?? null;
    registerTimeline?.(scrollNode);
    const viewport = scrollNode ? attachTimelineViewport(scrollNode) : null;
    viewportRef.current = viewport;
    const detachViewport = viewport ? onViewportAttach?.(viewport) : undefined;
    const stopRememberingRelease = viewport?.onFollowReleased(rememberReleasedPosition);
    let contentSizeFrame: number | null = null;
    // LegendList lays rows out from layout effects; the next frame sees them settled.
    let scheduledData: unknown = null;
    const scheduleContentSizeChanged = () => {
      if (!list) return;
      const laidOutData = list.getState().data;
      if (contentSizeFrame !== null) {
        if (scheduledData === laidOutData) return;
        cancelAnimationFrame(contentSizeFrame);
      }
      scheduledData = laidOutData;
      contentSizeFrame = requestAnimationFrame(() => {
        contentSizeFrame = null;
        handleContentSizeChanged(laidOutData);
      });
    };
    const stopListeningToContentSize = list
      ?.getState()
      .listen("totalSize", () => scheduleContentSizeChanged());
    scheduleContentSizeChanged();
    return () => {
      stopListeningToContentSize?.();
      stopRememberingRelease?.();
      if (contentSizeFrame !== null) cancelAnimationFrame(contentSizeFrame);
      detachViewport?.();
      viewport?.dispose();
      if (viewportRef.current === viewport) viewportRef.current = null;
      // Refresh frames only read the list; disclosure frames still run so the
      // settle flag clears.
      if (minimapRefreshFrameRef.current !== null) {
        cancelAnimationFrame(minimapRefreshFrameRef.current);
        minimapRefreshFrameRef.current = null;
      }
      listRef.current = null;
      registerTimeline?.(null);
    };
  });

  useThreadFindPositionReader({
    threadKey: listIdentityKey,
    navigate: navigateTimeline,
    timelineViewportElement,
    findFoldRunIds,
    timelineEntries,
    latestRun,
    runningRunId,
    isWorking,
    runlessWorkActive,
    rows,
    contentInsetEndAdjustment,
  });

  useThreadFindNavigation({
    // Find reveals its match only after the opening restore settles; both
    // scroll the list directly, so the restore would otherwise pull it back.
    listReady: findListReady && !restoringThreadPosition,
    historyControls,
    entries: timelineEntries,
    container: timelineViewportElement,
    query: normalizedFindQuery,
    match: activeFindMatch,
    navigationId: findNavigationId,
    rowIndex: activeFindMatch ? rows.findIndex((row) => row.id === activeFindMatch.entryId) : -1,
    listRef,
    contentInsetEndAdjustment,
  });

  // LegendList moves rows one commit late; per-row providers prevent thread context leaks.
  const onAudioPlaybackChange = (rowId: string, event: SyntheticEvent) => {
    const audio = event.target;
    if (!(audio instanceof HTMLAudioElement)) return;
    setPlayingAudioRows((current) => {
      const playing = !audio.paused && !audio.ended;
      if (playing === current.has(audio)) return current;
      const next = new Map(current);
      if (playing) next.set(audio, rowId);
      else next.delete(audio);
      return next;
    });
  };
  const onAudioUnmount = useStableCallback((audio: HTMLAudioElement) => {
    setPlayingAudioRows((current) => {
      if (!current.has(audio)) return current;
      const next = new Map(current);
      next.delete(audio);
      return next;
    });
  });
  const renderItem = ({ item }: { item: MessagesTimelineRow }) => (
    <TimelineRowCtx value={sharedState}>
      <div
        className="messages-timeline-row-frame"
        onPlayCapture={(event) => onAudioPlaybackChange(item.id, event)}
        onPauseCapture={(event) => onAudioPlaybackChange(item.id, event)}
        onEndedCapture={(event) => onAudioPlaybackChange(item.id, event)}
      >
        <div
          ref={observeLaneWidth}
          className="chat-content-lane overflow-x-clip"
          data-timeline-root="true"
        >
          <AudioPreviewUnmountContext value={onAudioUnmount}>
            <TimelineRowContent row={item} />
          </AudioPreviewUnmountContext>
        </div>
      </div>
    </TimelineRowCtx>
  );
  const listExtraData = { identity: listIdentityKey, rowCount: rows.length, sharedState };
  const timelineListFooter = (
    <TimelineListFooter
      composerInset={anchoredEndSpace ? 0 : contentInsetEndAdjustment}
      onGrow={onFooterGrow}
    >
      {footer}
      {unmatchedPendingApprovals.length > 0 ? (
        <TimelineRowCtx value={sharedState}>
          <div className="messages-timeline-row-frame">
            <div className="chat-content-lane overflow-x-clip" data-timeline-root="true">
              <WorkLogBlock>
                {unmatchedPendingApprovals.map((approval) => (
                  <TimelinePendingApprovalRow key={approval.requestId} approval={approval} />
                ))}
              </WorkLogBlock>
            </div>
          </div>
        </TimelineRowCtx>
      ) : null}
    </TimelineListFooter>
  );

  const forwardMinimapWheel = (event: WheelEvent) => {
    const scrollNode = listRef.current?.getScrollableNode();
    if (scrollNode) forwardWheelToTimeline(event, scrollNode);
  };


  return {
    activityAnnouncer,
    activityState,
    forwardMinimapWheel,
    listExtraData,
    listHeader,
    renderItem,
    setTimelineList,
    timelineListFooter,
  };
}
