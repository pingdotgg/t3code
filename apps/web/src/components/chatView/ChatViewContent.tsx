import { EMPTY_USAGE_LIMIT_SOURCES } from "./chatViewTypes";
import { PreviewSessionSync } from "./PreviewSessionSync";
import { ScrollToEndButton, WorkspaceFileDropOverlay } from "../chat/TimelineOverlays";
import { announcedRun, isDetailBehindShell } from "../chat/threadActivityAnnouncement";
import { ThreadFind, ThreadFindCanvas } from "../chat/ThreadFindProvider";
import { THREAD_FIND_BAR_RESERVED_HEIGHT } from "../chat/ThreadFindBar";
import { ChatBannerLane } from "../chat/ChatBannerLane";
import { WorkspaceMutationIdContext } from "../chat/ChatMarkdownMedia";
import { isElectron } from "../../env";
import { useRightPanelStore } from "../../rightPanelStore";
import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import { ThreadPreviewMiniPlayer } from "../preview/ThreadPreviewMiniPlayer";
import { previewMiniPlayerSourceKey } from "../../previewMiniPlayerStore";
import { LinkPullRequestDialogHost } from "../pullRequest/LinkPullRequestDialog";
import { makeWorkspaceFileDropHandlers } from "../chat/workspaceFileDrop";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { ExpandedImageDialogHost } from "../chat/ExpandedImageDialog";
import {
  BranchRestoreConfirmHost,
  DeviceSetupDialogHost,
  PullRequestThreadDialogHost,
  RevertConfirmHost,
} from "../chat/ChatOverlayHosts";
import { ThreadTimeline } from "../chat/ThreadTimeline";
import { ChatHeader } from "../chat/ChatHeader";
import { RightPanelMaximizeControl } from "../chat/PanelLayoutControls";
import { ThreadDetailsPanel } from "../chat/ThreadDetailsPanel";
import { ThreadVisitWatermark } from "../chat/ThreadVisitWatermark";
import { ChatTerminalDrawers } from "../chat/ChatTerminalDrawers";
import { ChatRightPanel } from "../chat/ChatRightPanel";
import type { ReactNode } from "react";
import type { ChatViewState } from "./useChatViewState";
import { ChatViewComposerColumn } from "./ChatViewComposerColumn";

/** Workspace layout for an open thread: timeline column, composer, right panel, and overlays. */
export function ChatViewContent(props: {
  readonly state: ChatViewState;
  readonly rightPanelContent: ReactNode;
  readonly panelLayoutControls: ReactNode;
  readonly panelToggleControls: ReactNode;
  readonly threadPanelHeaderControl: ReactNode;
  readonly workspaceFileDropHandlers: ReturnType<typeof makeWorkspaceFileDropHandlers>;
}) {
  const {
    rightPanelContent,
    panelLayoutControls,
    panelToggleControls,
    threadPanelHeaderControl,
    workspaceFileDropHandlers,
    state,
  } = props;
  const {
  activateRightPanelSurfaceStable, activeActivityRun, activeContextWindow, activeDraftLogicalProjectKey,
  activeEnvironmentServerBrowser, activeLatestRun, activePendingApproval, activePendingUserInput,
  activePreviewState, activeProject, activeProjectScripts, activeProviderInstanceId,
  activeRunningTurnId, activeTerminalLabelsById, activeTerminalLaunchContext, activeThread,
  activeThreadBranch, activeThreadKey, activeThreadRef, activeThreadShell,
  activeWorkStartedAt, activeWorkspaceRoot, addDeviceSurfaceStable, addDiffSurfaceStable,
  addFilesSurfaceStable, addPullRequestSurfaceStable, addPullRequestsSurfaceStable, addTerminalContextToDraftStable,
  addTerminalSurfaceStable, attachTimelineViewport, autoEnvironmentLabel, availableEditors,
  availableRevertTurnCounts, browserAvailable, canAutoBalanceEnvironments, canChangeEnvironment,
  canCheckoutPullRequestIntoThread, canOperatePreview, canOperateTerminal, canOperateThread,
  canOverrideServerThreadEnvMode, canWriteSourceControl, canvasPreview, chatCanvasStore,
  citationHistory, citationRequest, citeAssistantTextStable, closeAllRightPanelSurfacesStable,
  closeOtherRightPanelSurfacesStable, closePreviewPanelStable, closeRightPanelSurfaceStable, closeRightPanelSurfacesToRightStable,
  closeTerminalShortcutLabel, composerOverlayElement, composerReservedHeight, composerTimelineInset,
  conversationArea, copyRightPanelFilePathStable, createBrowserSurface, createBrowserSurfaceStable,
  deleteProjectScriptStable, deviceState, displayedThreadRef, displayedTimelineKey,
  downloadFileAttachmentStable, draftId, draftTimelineEntries, embedded,
  envLocked, envMode, focusComposerStable, getShortcutContextStable,
  gitCwd, handleNewThreadInActiveProjectStable, handleOpenDraftProjectSettingsStable, handlePreparedPullRequestThreadStable,
  handleSwitchCheckoutToThreadStable, hasTimelineTopBanner, headerParentThreadLink, heldApprovalRequestIds,
  inlineRightPanelOwnsTitleBar, insertArtifactTemplateStable, isCompacting, isDraftHeroState,
  isGitRepo, isPreparingWorktree, isProviderSubagent, isRevertingCheckpoint,
  isServerThread, isThreadFindActive, isWorking, isWorkspaceFileDragActive,
  keybindings, lastInvokedScriptByProjectId, legendListRef, loadBalancingSettings,
  localCheckoutBranchMismatch, logicalProjectEnvironments, moveRightPanelSurfaceStable, multipleModelSelections,
  newTerminalShortcutLabel, onAutoEnvironmentStable, onCancelWorktreeSetupStable, onConfirmRevertStable,
  onEnvModeChangeStable, onEnvironmentChangeStable, onExpandTimelineImageStable, onForkFromRunStable,
  onIsAtEndChangeStable, onOpenRelatedThreadStable, onOpenToolDiffStable, onOpenTurnDiffStable,
  onOpenWorktreeSetupTerminal, onRespondToApprovalStable, onRetryWorkspacePreparationStable, onRevertTimelineTurnStable,
  onStartFromOriginChange, onTimelineAnchorReadyStable, onTimelineAnchorSizeChangedStable, onTimelineFooterGrowStable,
  onWorktreeSetupWorkLocallyStable, openChangesFromThreadPanelStable, openFileAttachmentStable, openProviderSetupStable,
  openPullRequestDialogStable, openSideChatStable, openThreadFindStable, panelAnimationDurationMs,
  panelAnimationsActive, parentPanel, parentThreadLink, pendingApprovals,
  pendingFileSurfaceIds, providerStatusBannerKey, providerStatuses, pullRequestSurfaceAvailable,
  pullRequestsSurfaceAvailable, renderedRightPanelSurface, renderedRightPanelSurfaces, reserveTitleBarControlInset,
  resolvePreviewRuntimeTabId, resolvedTheme, respondingRequestIds, retryableWorkspacePreparationRunIds,
  rightPanelControlsAtRoot, rightPanelControlsInPanel, rightPanelMaximized, rightPanelOpen,
  rightPanelPresent, routeThreadDetailRef, routeThreadKey, routeThreadRef,
  runProjectScriptStable, runShellCommandStable, runlessWorkStartedAt, saveProjectScriptStable,
  scheduleComposerFocusStable, scrollToEnd, scrollToEndClearance, scrollToEndSummary,
  sendAppMessageStable, serverConfig, serverProjection, serverRuntime,
  setDismissedProviderStatusBannerKey, setPendingServerThreadBranch, setThreadError, setThreadErrorBannerDismissTick,
  setWorkspaceLayoutElement, shouldUsePlanSidebarSheet, showOpenInPicker, showScrollToBottom,
  shownPreviewMiniPlayer, sideChat, sideChatDisabledReason, sideChatsOffered,
  splitTerminalShortcutLabel, splitTerminalVerticalShortcutLabel, startFromOrigin, supportsConversationRollback,
  terminalUiState, threadDetailLoading, threadErrorBannerKey, threadErrorIsServerRuntimeError,
  threadFindEnabled, threadHistoryControls, threadPanelPopoverAnchorRef, threadPanelPopoverHandle,
  threadStartCheckpointReady, threadSyncPhase, timelineAnchorMessageId, timelineEntriesInput,
  timelineFooter, timelineLiveFollowEnabled, timelineSkills, timelineThreadError,
  timestampFormat, toggleRightPanelMaximizedStable, turnDiffSummaries, updateProjectScriptStable,
  visibleProviderStatus, workflowOpening, workspaceLayoutElement, workspaceMutationId,
  worktreeSetup,
  } = state;
  if (!activeThread) {
    return null;
  }

  return (
    <div
      ref={setWorkspaceLayoutElement}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      {embedded ? null : (
        <DeviceSetupDialogHost
          threadKey={activeThreadKey}
          threadRef={activeThreadRef}
          state={deviceState}
        />
      )}
      {rightPanelControlsAtRoot && !embedded ? panelLayoutControls : null}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-x-hidden",
          rightPanelMaximized ? "w-0 flex-none" : "flex-1",
        )}
        data-chat-column-maximized-away={rightPanelMaximized ? "true" : "false"}
        data-chat-column
        inert={rightPanelMaximized}
      >
        {embedded ? null : (
          <header
            ref={threadPanelPopoverAnchorRef}
            data-chat-header
            className={cn(
              "relative bg-background [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out",
              isElectron
                ? cn(
                    "drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 sm:px-5",
                    reserveTitleBarControlInset &&
                      !inlineRightPanelOwnsTitleBar &&
                      "wco:pr-(--workspace-native-controls-inset)",
                  )
                : "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            {isElectron && rightPanelControlsAtRoot ? (
              <span
                aria-hidden
                className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
              />
            ) : null}
            {!rightPanelControlsAtRoot && !rightPanelControlsInPanel ? panelLayoutControls : null}
            {inlineRightPanelOwnsTitleBar ? threadPanelHeaderControl : null}
            <ChatHeader
              activeThreadEnvironmentId={activeThread.environmentId}
              activeThreadId={activeThread.id}
              isServerThread={isServerThread}
              activeThreadTitle={activeThread.title}
              activeThreadLinkOrigin={activeThreadShell?.linkOrigin?.label ?? null}
              activeProject={activeProject ?? null}
              parentThreadLink={headerParentThreadLink}
              onOpenThread={onOpenRelatedThreadStable}
              rightPanelOpen={inlineRightPanelOwnsTitleBar}
              onNewThreadInProject={handleNewThreadInActiveProjectStable}
              {...(activeDraftLogicalProjectKey
                ? { onOpenProjectSettings: handleOpenDraftProjectSettingsStable }
                : {})}
              {...(threadFindEnabled ? { onFindInThread: openThreadFindStable } : {})}
            />
          </header>
        )}

        <div className="relative flex min-h-0 min-w-0 flex-1">
          <ThreadFindCanvas
            findOptions={{
              skills: timelineSkills,
              progressive: serverConfig?.threadFindProgressive === true,
              thread: activeThreadRef,
              enabled: threadFindEnabled,
            }}
            store={chatCanvasStore}
            threadRef={activeThreadRef}
            preview={canvasPreview}
            detailsCardTopInset={isThreadFindActive ? THREAD_FIND_BAR_RESERVED_HEIGHT : 0}
            composerOverlayElement={isDraftHeroState ? null : composerOverlayElement}
            data-chat-workspace-drop-target="true"
            onDragEnter={workspaceFileDropHandlers.onDragEnter}
            onDragOver={workspaceFileDropHandlers.onDragOver}
            onDragLeave={workspaceFileDropHandlers.onDragLeave}
            onDrop={workspaceFileDropHandlers.onDrop}
          >
            <ThreadFind onClose={focusComposerStable} />
            {isWorkspaceFileDragActive ? <WorkspaceFileDropOverlay /> : null}
            <ChatBannerLane
              environmentId={activeThread.environmentId}
              providerStatus={visibleProviderStatus}
              providerStatusBannerKey={providerStatusBannerKey}
              setDismissedProviderStatusBannerKey={setDismissedProviderStatusBannerKey}
              onOpenProviderSetup={openProviderSetupStable}
              threadId={activeThread.id}
              threadError={timelineThreadError}
              threadErrorClass={
                threadErrorIsServerRuntimeError ? (serverRuntime?.lastErrorClass ?? null) : null
              }
              threadErrorCode={
                threadErrorIsServerRuntimeError ? (serverRuntime?.lastErrorCode ?? null) : null
              }
              threadErrorBannerKey={threadErrorBannerKey}
              setThreadError={setThreadError}
              setThreadErrorBannerDismissTick={setThreadErrorBannerDismissTick}
            />
            <div
              {...conversationArea}
              className="relative flex min-h-0 flex-1 flex-col bg-background"
            >
              <WorkspaceMutationIdContext value={workspaceMutationId}>
                <ThreadTimeline
                  pendingApprovals={pendingApprovals}
                  heldApprovalRequestIds={heldApprovalRequestIds}
                  respondingRequestIds={respondingRequestIds}
                  onRespondToApproval={onRespondToApprovalStable}
                  canOperateThread={canOperateThread}
                  threadDetailRef={routeThreadDetailRef}
                  entriesInput={timelineEntriesInput}
                  draftEntries={isServerThread ? null : draftTimelineEntries}
                  activeThreadKey={activeThreadKey}
                  syncing={threadSyncPhase !== null}
                  detailLoading={threadDetailLoading}
                  citationRequest={citationRequest}
                  citationHistory={citationHistory}
                  onCiteAssistantText={citeAssistantTextStable}
                  {...(activeProject
                    ? { onRunShellCommand: parentPanel?.runShellCommand ?? runShellCommandStable }
                    : {})}
                  isWorking={isWorking}
                  runlessWorkActive={runlessWorkStartedAt !== null}
                  isCompacting={isCompacting}
                  awaitingUser={
                    activePendingApproval !== null
                      ? "approval"
                      : activePendingUserInput !== null ||
                          // A secret request has no runtime request; the shell carries it.
                          activeThreadShell?.hasPendingUserInput === true
                        ? "input"
                        : null
                  }
                  awaitingRequestId={
                    activePendingApproval?.requestId ?? activePendingUserInput?.requestId ?? null
                  }
                  activeTurnStartedAt={activeWorkStartedAt}
                  worktreeSetup={worktreeSetup}
                  onCancelWorktreeSetup={onCancelWorktreeSetupStable}
                  retryableWorkspacePreparationRunIds={retryableWorkspacePreparationRunIds}
                  onRetryWorkspacePreparation={onRetryWorkspacePreparationStable}
                  {...(draftId
                    ? { onWorktreeSetupWorkLocally: onWorktreeSetupWorkLocallyStable }
                    : {})}
                  {...(onOpenWorktreeSetupTerminal ? { onOpenWorktreeSetupTerminal } : {})}
                  isPreparingWorktree={isPreparingWorktree}
                  footer={timelineFooter}
                  listRef={legendListRef}
                  runs={serverProjection?.runs ?? []}
                  latestRun={activeActivityRun}
                  announcedRun={announcedRun(activeActivityRun, serverProjection?.runs ?? [])}
                  detailBehindShell={isDetailBehindShell(
                    activeLatestRun,
                    activeThreadShell?.latestRun ?? null,
                  )}
                  runningRunId={activeRunningTurnId}
                  turnDiffSummaries={turnDiffSummaries}
                  activeThreadEnvironmentId={
                    displayedThreadRef?.environmentId ?? activeThread.environmentId
                  }
                  routeThreadKey={displayedTimelineKey}
                  displayThreadKey={displayedTimelineKey}
                  announceTurnStatus={!isProviderSubagent}
                  onOpenToolDiff={parentPanel?.openToolDiff ?? onOpenToolDiffStable}
                  // Side chat runs keep no checkpoints to diff, and a fork would promote the side chat.
                  {...(embedded
                    ? {}
                    : { onOpenTurnDiff: onOpenTurnDiffStable, onForkFromRun: onForkFromRunStable })}
                  onOpenThread={onOpenRelatedThreadStable}
                  parentThreadLink={parentThreadLink}
                  workflowOpening={workflowOpening}
                  supportsConversationRollback={supportsConversationRollback}
                  threadStartCheckpointReady={threadStartCheckpointReady}
                  availableRevertTurnCounts={availableRevertTurnCounts}
                  onRevertToTurnCount={onRevertTimelineTurnStable}
                  onUseArtifactTemplate={insertArtifactTemplateStable}
                  onSendAppMessage={sendAppMessageStable}
                  isRevertingCheckpoint={isRevertingCheckpoint}
                  onImageExpand={onExpandTimelineImageStable}
                  onFileOpen={openFileAttachmentStable}
                  onFileDownload={downloadFileAttachmentStable}
                  markdownCwd={gitCwd ?? undefined}
                  resolvedTheme={resolvedTheme}
                  timestampFormat={timestampFormat}
                  workspaceRoot={activeWorkspaceRoot}
                  skills={timelineSkills}
                  anchorMessageId={timelineAnchorMessageId}
                  onAnchorReady={onTimelineAnchorReadyStable}
                  onAnchorSizeChanged={onTimelineAnchorSizeChangedStable}
                  contentInsetEndAdjustment={composerTimelineInset}
                  liveFollowEnabled={timelineLiveFollowEnabled}
                  onIsAtEndChange={onIsAtEndChangeStable}
                  onViewportAttach={attachTimelineViewport}
                  onFooterGrow={onTimelineFooterGrowStable}
                  hideEmptyPlaceholder={isDraftHeroState || threadDetailLoading}
                  emptyPlaceholderInset={composerReservedHeight}
                  topFadeEnabled={!hasTimelineTopBanner}
                  {...(threadHistoryControls === undefined
                    ? {}
                    : { historyControls: threadHistoryControls })}
                />
              </WorkspaceMutationIdContext>

              {showScrollToBottom && !isThreadFindActive && (
                <ScrollToEndButton
                  bottom={scrollToEndClearance + 4}
                  summary={scrollToEndSummary}
                  onScrollToEnd={() => scrollToEnd(true)}
                />
              )}
            </div>

            <ChatViewComposerColumn state={state} />

            {canOperatePreview && activeThreadRef && activeEnvironmentServerBrowser && !embedded ? (
              <PreviewSessionSync threadRef={activeThreadRef} />
            ) : null}
            {activeThreadRef && shownPreviewMiniPlayer && !embedded ? (
              <ThreadPreviewMiniPlayer
                key={`${activeThreadKey}:${previewMiniPlayerSourceKey(shownPreviewMiniPlayer.source)}`}
                threadRef={activeThreadRef}
                miniPlayer={shownPreviewMiniPlayer}
              />
            ) : null}

            {embedded ? null : (
              <>
                <BranchRestoreConfirmHost
                  threadKey={activeThreadKey}
                  threadBranch={localCheckoutBranchMismatch?.threadBranch ?? ""}
                  canWriteSourceControl={canWriteSourceControl}
                  onConfirm={handleSwitchCheckoutToThreadStable}
                />

                <ThreadDetailsPanel
                  anchor={threadPanelPopoverAnchorRef}
                  handle={threadPanelPopoverHandle}
                  forceNewWorktree={multipleModelSelections !== null}
                  environmentId={activeThread.environmentId}
                  threadId={activeThread.id}
                  projectId={activeThread.projectId}
                  worktreePath={activeThread.worktreePath}
                  isServerThread={isServerThread}
                  {...(draftId ? { draftId } : {})}
                  activeProjectName={activeProject?.title}
                  activeProjectScripts={activeProject ? activeProjectScripts : undefined}
                  preferredScriptId={
                    activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
                  }
                  keybindings={keybindings}
                  availableEditors={availableEditors}
                  showOpenInPicker={showOpenInPicker}
                  openInShortcutEnabled={
                    !(
                      rightPanelOpen &&
                      renderedRightPanelSurface?.kind === "file" &&
                      renderedRightPanelSurface.attachment === undefined
                    )
                  }
                  gitCwd={gitCwd}
                  isGitRepo={isGitRepo}
                  envLocked={envLocked}
                  availableEnvironments={logicalProjectEnvironments}
                  autoEnvironmentLabel={autoEnvironmentLabel}
                  onAutoEnvironment={
                    draftId &&
                    !envLocked &&
                    canAutoBalanceEnvironments &&
                    loadBalancingSettings.loadBalancingEnabled
                      ? onAutoEnvironmentStable
                      : undefined
                  }
                  {...(canChangeEnvironment
                    ? { onEnvironmentChange: onEnvironmentChangeStable }
                    : {})}
                  onEnvModeChange={onEnvModeChangeStable}
                  envMode={envMode}
                  {...(canOverrideServerThreadEnvMode
                    ? {
                        activeThreadBranchOverride: activeThreadBranch,
                        onActiveThreadBranchOverrideChange: setPendingServerThreadBranch,
                      }
                    : {})}
                  startFromOrigin={startFromOrigin}
                  onStartFromOriginChange={onStartFromOriginChange}
                  {...(canCheckoutPullRequestIntoThread
                    ? { onCheckoutPullRequestRequest: openPullRequestDialogStable }
                    : {})}
                  onComposerFocusRequest={scheduleComposerFocusStable}
                  {...(isServerThread && isGitRepo
                    ? { onOpenChanges: openChangesFromThreadPanelStable }
                    : {})}
                  onRunProjectScript={runProjectScriptStable}
                  onAddProjectScript={saveProjectScriptStable}
                  onUpdateProjectScript={updateProjectScriptStable}
                  onDeleteProjectScript={deleteProjectScriptStable}
                  usage={{
                    providerInstanceId: activeProviderInstanceId,
                    providers: providerStatuses,
                    sources: serverConfig?.usageLimitSources ?? EMPTY_USAGE_LIMIT_SOURCES,
                    contextWindow: activeContextWindow,
                  }}
                />

                <PullRequestThreadDialogHost
                  threadKey={activeThreadKey}
                  environmentId={activeThread.environmentId}
                  threadId={activeThread.id}
                  cwd={activeProject?.workspaceRoot ?? null}
                  onPrepared={handlePreparedPullRequestThreadStable}
                />
              </>
            )}
          </ThreadFindCanvas>
        </div>

        {embedded ? null : (
          <ChatTerminalDrawers
            activeThreadKey={activeThreadKey}
            activeTerminalOpen={Boolean(terminalUiState.terminalOpen)}
            composerHeight={composerReservedHeight}
            launchContext={activeTerminalLaunchContext ?? null}
            splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
            splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
            newShortcutLabel={newTerminalShortcutLabel ?? undefined}
            closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
            keybindings={keybindings}
            onAddTerminalContext={addTerminalContextToDraftStable}
          />
        )}
      </div>

      {rightPanelPresent && activeThreadRef && !embedded ? (
        <ChatRightPanel
          sheet={shouldUsePlanSidebarSheet}
          workspaceLayoutElement={workspaceLayoutElement}
          widthStorageKey={`t3code:preview-panel-width:${activeThreadKey}`}
          sheetAnimationDurationMs={panelAnimationsActive ? panelAnimationDurationMs : 0}
          onCloseSheet={closePreviewPanelStable}
          open={rightPanelOpen}
          keybindings={keybindings}
          getShortcutContext={getShortcutContextStable}
          maximized={rightPanelMaximized}
          layoutControls={
            rightPanelOpen ? (
              <div className="mr-px flex items-center gap-1">
                <RightPanelMaximizeControl
                  maximized={rightPanelMaximized}
                  onToggle={toggleRightPanelMaximizedStable}
                />
                {panelToggleControls}
              </div>
            ) : null
          }
          surfaces={renderedRightPanelSurfaces}
          environmentId={activeThreadRef.environmentId}
          activeSurfaceId={renderedRightPanelSurface?.id ?? null}
          pendingSurfaceIds={pendingFileSurfaceIds}
          previewSessions={activePreviewState.sessions}
          desktopByTabId={activePreviewState.desktopByTabId}
          previewRuntimeTabId={resolvePreviewRuntimeTabId}
          terminalLabelsById={activeTerminalLabelsById}
          onActivate={activateRightPanelSurfaceStable}
          onCloseSurface={closeRightPanelSurfaceStable}
          onRenameDevice={(surfaceId, title) => {
            if (activeThreadRef)
              useRightPanelStore.getState().renameDevice(activeThreadRef, surfaceId, title);
          }}
          onCloseOtherSurfaces={closeOtherRightPanelSurfacesStable}
          onCloseSurfacesToRight={closeRightPanelSurfacesToRightStable}
          onCloseAllSurfaces={closeAllRightPanelSurfacesStable}
          onMoveSurface={moveRightPanelSurfaceStable}
          onCopyFilePath={copyRightPanelFilePathStable}
          onAddBrowser={() => createBrowserSurface()}
          onAddBrowserInProfile={createBrowserSurfaceStable}
          onAddTerminal={addTerminalSurfaceStable}
          onAddDiff={addDiffSurfaceStable}
          onAddFiles={addFilesSurfaceStable}
          onAddPullRequest={addPullRequestSurfaceStable}
          onAddPullRequests={addPullRequestsSurfaceStable}
          onAddDevice={addDeviceSurfaceStable}
          onAddSideChat={sideChatsOffered ? openSideChatStable : undefined}
          browserAvailable={canOperatePreview && browserAvailable}
          terminalAvailable={activeProject !== null && canOperateTerminal}
          diffAvailable={isServerThread && isGitRepo}
          filesAvailable={activeProject !== null}
          pullRequestAvailable={pullRequestSurfaceAvailable}
          pullRequestsAvailable={pullRequestsSurfaceAvailable}
          deviceAvailable={activeThreadRef !== null}
          sideChatAvailable={sideChat.available}
          sideChatDisabledReason={sideChatDisabledReason}
        >
          {rightPanelContent}
        </ChatRightPanel>
      ) : null}

      <RevertConfirmHost threadKey={routeThreadKey} onConfirm={onConfirmRevertStable} />
      {embedded ? null : <LinkPullRequestDialogHost />}
      <ThreadVisitWatermark threadRef={routeThreadRef} />
      <ExpandedImageDialogHost threadKey={routeThreadKey} />
    </div>
  );
}
