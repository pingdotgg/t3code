import { MarkdownFindContext } from "./markdownFindContext";
import { memo } from "react";
import { LegendList } from "@legendapp/list/react";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import { TooltipScrollDismissArea } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { TimelineMinimap } from "./TimelineMinimap";
import { TimelineRowActivityCtx } from "./timelineRowContext";
import { CITED_HISTORY_LOADING, EMPTY_PENDING_APPROVALS, EMPTY_RESPONDING_REQUEST_IDS, EMPTY_RUN_IDS, EMPTY_TIMELINE_SKILLS, NOOP_OPEN_ATTACHMENT, NOOP_USE_ARTIFACT_TEMPLATE, TIMELINE_MAINTAIN_SCROLL_AT_END, TIMELINE_MAINTAIN_SCROLL_AT_END_SMOOTH, getItemType, keyExtractor } from "./messagesTimelineShared";
import type { MessagesTimelineProps } from "./messagesTimelineShared";
import { useConversationTimelineRows } from "./useConversationTimelineRows";
import { useConversationTimelineViewport } from "./useConversationTimelineViewport";
import { useConversationTimelineListState } from "./useConversationTimelineListState";

export const ConversationTimeline = memo(function ConversationTimeline(props: MessagesTimelineProps) {
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
  } = props;
  const rowsState = useConversationTimelineRows({ ...props });
  const viewportState = useConversationTimelineViewport({ ...props, ...rowsState });
  const listStateResult = useConversationTimelineListState({ ...props, ...rowsState, ...viewportState });
  const {
    citationThreadRef,
    disclosureToggleSettling,
    findActive,
    fullscreenAppRowId,
    listIdentityKey,
    minimapItems,
    minimapStripMap,
    prefersReducedMotion,
    rememberedPosition,
    restoringThreadPosition,
    rows,
    settlingListIdentity,
    showsEmptyState,
  } = rowsState;
  const {
    alwaysRender,
    alwaysRenderKeys,
    anchoredEndSpace,
    attachTimelineViewportElement,
    citationPositioning,
    handleItemSizeChanged,
    handleListLoad,
    handleScroll,
    maintainVisibleContentPosition,
    minimapCurrentIndex,
    minimapHasPersistentGutter,
    minimapHitStripWidth,
    navigateTimeline,
    readyCitationRequest,
    timelineViewportElement,
  } = viewportState;
  const {
    activityAnnouncer,
    activityState,
    forwardMinimapWheel,
    listExtraData,
    listHeader,
    renderItem,
    setTimelineList,
    timelineListFooter,
  } = listStateResult;

  if (showsEmptyState) {
    if (hideEmptyPlaceholder) {
      return (
        <>
          {activityAnnouncer}
          <div className="h-full min-h-0 bg-background" data-timeline-loading="true" />
        </>
      );
    }
    return (
      <>
        {activityAnnouncer}
        <div
          className="flex h-full items-center justify-center ps-(--chat-lane-inset-start) pe-(--chat-lane-inset-end)"
          style={{ paddingBottom: emptyPlaceholderInset }}
        >
          <p className="text-sm text-muted-foreground">Send a message to start the conversation.</p>
        </div>
      </>
    );
  }


  return (
    <>
      {activityAnnouncer}
      <MarkdownFindContext value={findActive}>
        <TimelineRowActivityCtx value={activityState}>
          <TooltipScrollDismissArea
            ref={attachTimelineViewportElement}
            className="relative h-full min-h-0"
            data-assistant-citation-viewport="true"
          >
            {onCiteAssistantText && citationThreadRef ? (
              <AssistantSelectionToolbar
                viewport={timelineViewportElement}
                threadRef={citationThreadRef}
                onCite={onCiteAssistantText}
              />
            ) : null}
            <LegendList<MessagesTimelineRow>
              ref={setTimelineList}
              data={rows}
              extraData={listExtraData}
              keyExtractor={keyExtractor}
              getItemType={getItemType}
              renderItem={renderItem}
              estimatedItemSize={90}
              initialScrollAtEnd={
                !findActive && citationRequest === null && rememberedPosition?.atEnd !== false
              }
              // Legend needs a data refresh to mount new pins without a scroll event.
              dataVersion={`${readyCitationRequest?.key ?? listIdentityKey}:${alwaysRenderKeys.join(",")}`}
              {...(alwaysRender ? { alwaysRender } : {})}
              onLoad={handleListLoad}
              {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
              contentInsetEndAdjustment={anchoredEndSpace ? contentInsetEndAdjustment : 0}
              maintainScrollAtEnd={
                citationPositioning ||
                (restoringThreadPosition && rememberedPosition?.atEnd === false) ||
                anchoredEndSpace ||
                !liveFollowEnabled ||
                fullscreenAppRowId !== null ||
                disclosureToggleSettling
                  ? false
                  : isWorking && !prefersReducedMotion && settlingListIdentity === null
                    ? TIMELINE_MAINTAIN_SCROLL_AT_END_SMOOTH
                    : TIMELINE_MAINTAIN_SCROLL_AT_END
              }
              maintainVisibleContentPosition={
                findActive ||
                citationPositioning ||
                (restoringThreadPosition && rememberedPosition?.atEnd === false)
                  ? false
                  : maintainVisibleContentPosition
              }
              maintainScrollAtEndThreshold={1}
              onScroll={handleScroll}
              onItemSizeChanged={handleItemSizeChanged}
              className={cn(
                "messages-timeline-scroll scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain [overflow-anchor:none]",
                topFadeEnabled && "topbar-scroll-fade",
              )}
              ListHeaderComponent={listHeader}
              ListFooterComponent={timelineListFooter}
            />
            <TimelineMinimap
              items={minimapItems}
              hasPersistentGutter={minimapHasPersistentGutter}
              hitStripWidth={minimapHitStripWidth}
              currentIndex={minimapCurrentIndex}
              stripMap={minimapStripMap}
              onWheel={forwardMinimapWheel}
              onSelect={(item) => {
                navigateTimeline();
                void listRef.current?.scrollToIndex({
                  index: item.rowIndex,
                  animated: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
                  viewOffset: 24,
                });
              }}
            />
          </TooltipScrollDismissArea>
        </TimelineRowActivityCtx>
      </MarkdownFindContext>
    </>
  );
});
