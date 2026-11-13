import { EMPTY_COMPOSER_BANNER_ITEMS } from "./chatViewTypes";
import { ChildThreadApprovals } from "../chat/ChildThreadApprovals";
import { type ServerProvider } from "@t3tools/contracts";
import { BranchToolbar } from "../BranchToolbar";
import { ComposerContextPermissions } from "../ComposerContextPermissions";
import { shouldShowInstanceBadge } from "../../providerInstances";
import { ChatComposer } from "../chat/ChatComposer";
import { DraftHeroHeadline } from "../chat/DraftHeroHeadline";
import { NativeChildWorkDialog } from "../chat/NativeChildWorkDialog";
import { ProviderSubagentBar } from "../chat/ProviderSubagentBar";
import { ComposerBannerStack } from "../chat/ComposerBannerStack";
import { ComposerSurface } from "../chat/ComposerSurface";
import {
  MOBILE_COMPOSER_VIEW_TRANSITION_NAME,
  MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
} from "../chat/draftHeroTransition";
import type { ChatViewState } from "./useChatViewState";

/** Composer area of the chat column: editor surface, branch toolbar, and queued runs. */
export function ChatViewComposerColumn({ state }: { readonly state: ChatViewState }) {
  const {
  activeEnvironmentUnavailable, activeEnvironmentUnavailableState, activePendingApproval, activePendingDraftAnswers,
  activePendingIsResponding, activePendingProgress, activePendingQuestionIndex, activePendingResolvedAnswers,
  activeProject, activeProjectDefaultModelSelection, activeProjectRef, activeProjectRepository,
  activeProposedPlan, activeProviderStatus, activeProviderThread, activeThread,
  activeThreadBranch, activeThreadId, activeThreadKey, activeThreadLiveTokenUsage,
  activeThreadRef, activeThreadShell, attachFollowComposerOverlay, attachmentUploadsCapabilityKnown,
  autoEnvironmentLabel, branchToolbarRef, canAutoBalanceEnvironments, canChangeEnvironment,
  canCheckoutPullRequestIntoThread, canInterruptRunningThread, canOperateThread, canOverrideServerThreadEnvMode,
  compactDisabled, compactDisabledReason, compactThreadUnavailable, composerArea,
  composerBannerItems, composerDraftTarget, composerFilesRef, composerHasNonPromptContent,
  composerImagesRef, composerMounted, composerRef, composerTerminalContextsRef,
  defaultRuntimeMode, draftHeroComposerAnchorRef, draftHeroTransitionGroupRef, draftId,
  envLocked, envMode, environmentId, feedbackUploading,
  focusComposerStable, forceExpandedMobileComposer, getModelDisabledReason, gitCwd,
  handleInteractionModeChangeStable, handleRuntimeModeChangeStable, hasHeldQueuedRuns, interactionMode,
  isCompacting, isDraftHeroState, isEnvironmentChanging, isGitRepo,
  isLocalDraftThread, isPreparingWorktree, isResuming, isRevertingCheckpoint,
  isSendBusy, isServerThread, keepFullHistory, keybindings,
  loadBalancingSettings, logicalProjectEnvironments, maxFileAttachmentBytes, modelPickerLockedProvider,
  multipleModelSelections, onAdvanceActivePendingUserInputStable, onAutoEnvironmentStable, onChangeActivePendingUserInputCustomAnswer,
  onComposerCompactContextStable, onComposerPageScrollKeyDownStable, onComposerPageScrollKeyUpStable, onComposerPageScrollReleaseStable,
  onComposerResumeStable, onComposerSendStable, onDismissUserInputStable, onEnvModeChangeStable,
  onEnvironmentChangeStable, onExpandTimelineImageStable, onHeldRequestIdsChange, onImplementPlanInNewThreadStable,
  onInterruptStable, onPreviousActivePendingUserInputQuestionStable, onProviderModelSelectStable, onSelectActivePendingUserInputOptionStable,
  onStartFromOriginChange, openFileAttachmentStable, openProviderSetupStable, openPullRequestDialogStable,
  openUsageLimits, parentThreadLink, pendingApprovals, pendingUserInputs,
  phase, projectCloneSendBlockReason, promptRef, providerInstanceEntries,
  providerStatuses, providerSubagentEffortLabel, providerSubagentModelLabel, providerSubagentStatus,
  publishComposerOverlayHeightStable, queuedRunEdit, reportedModelSelection, resolvedTheme,
  respondingRequestIds, resumableRunId, resumeCompactionTokens, routeKind,
  routeThreadRef, runtimeMode, scheduleComposerFocusStable, selectedProviderEntry,
  sendQueuesBehindSetup, serverConfig, serverVisibleTurnItems, setComposerOverlayElement,
  setMultipleModelSelectionsStable, setPendingServerThreadBranch, setThreadError, settings,
  setupQueueSendThreadKey, showComposerContextStrip, showPlanFollowUpPrompt, showProviderSubagentBar,
  sideChat, sideChatDisabledReason, startFromOrigin, supportsAttachmentUploads,
  supportsPullRequests, supportsQuestionAttachments, terminalUiState, threadDetailLoading,
  threadId, threadSyncPhase, timelineEntries, toggleInteractionModeStable,
  toggleKeepFullHistoryStable, usageLimitsKey, usageLimitsOffered, worktreeSetupBlocksSend,
  } = state;
  if (!activeThread) {
    return null;
  }

  return (
            <div
              {...composerArea}
              ref={(overlay: HTMLDivElement | null) => {
                setComposerOverlayElement(overlay);
                attachFollowComposerOverlay(overlay);
              }}
              inert={isRevertingCheckpoint}
              data-chat-composer-overlay="true"
              className={
                isDraftHeroState
                  ? "pointer-events-none absolute inset-0 z-20 flex items-center"
                  : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
              }
            >
              <div ref={draftHeroTransitionGroupRef} className="chat-composer-lane w-full">
                <div
                  data-chat-composer-stack="true"
                  className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-content-max-width)"
                >
                  {isDraftHeroState ? (
                    <div className="absolute inset-x-0 bottom-full">
                      <div
                        className="pb-4 group-has-data-[composer-shoulder-tab]/composer-stack:pb-0"
                        style={
                          forceExpandedMobileComposer
                            ? { viewTransitionName: MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME }
                            : undefined
                        }
                      >
                        <DraftHeroHeadline
                          draftId={draftId}
                          activeProjectRef={activeProjectRef}
                          activeProjectTitle={activeProject?.title ?? null}
                        />
                      </div>
                    </div>
                  ) : null}
                  <div
                    ref={draftHeroComposerAnchorRef}
                    className="relative z-10"
                    style={
                      forceExpandedMobileComposer
                        ? { viewTransitionName: MOBILE_COMPOSER_VIEW_TRANSITION_NAME }
                        : undefined
                    }
                  >
                    <ChildThreadApprovals threadRef={activeThreadRef} />
                    <ComposerSurface.Shell contextRow={showComposerContextStrip}>
                      <ComposerSurface.Host
                        inert={queuedRunEdit.isSaving}
                        aria-busy={queuedRunEdit.isSaving}
                      >
                        <div className="relative z-10">
                          {showProviderSubagentBar ? (
                            <ProviderSubagentBar
                              provider={selectedProviderEntry ?? null}
                              showInstanceBadge={
                                selectedProviderEntry !== undefined &&
                                shouldShowInstanceBadge(
                                  selectedProviderEntry,
                                  providerInstanceEntries,
                                )
                              }
                              modelLabel={providerSubagentModelLabel}
                              effortLabel={providerSubagentEffortLabel}
                              status={providerSubagentStatus}
                              onOpenParent={parentThreadLink?.open ?? null}
                              actions={
                                selectedProviderEntry?.driverKind === "antigravity" ? (
                                  <NativeChildWorkDialog
                                    environmentId={environmentId}
                                    threadId={threadId}
                                  />
                                ) : null
                              }
                            />
                          ) : null}
                          {!composerMounted ? null : (
                            <ChatComposer
                              canOperateThread={canOperateThread}
                              reportedModelSelection={reportedModelSelection}
                              multipleModelSelections={multipleModelSelections}
                              supportsMultipleModels={
                                serverConfig?.environment.capabilities.requiredWorktreeBootstrap ===
                                true
                              }
                              onMultipleModelSelectionsChange={setMultipleModelSelectionsStable}
                              composerRef={composerRef}
                              composerDraftTarget={composerDraftTarget}
                              environmentId={environmentId}
                              attachmentUploadsCapabilityKnown={attachmentUploadsCapabilityKnown}
                              supportsAttachmentUploads={supportsAttachmentUploads}
                              supportsQuestionAttachments={supportsQuestionAttachments}
                              maxFileAttachmentBytes={maxFileAttachmentBytes}
                              routeKind={routeKind}
                              routeThreadRef={routeThreadRef}
                              draftId={draftId}
                              activeThreadId={activeThreadId}
                              activeThread={activeThread}
                              activeThreadShell={activeThreadShell}
                              promptHistoryEntries={timelineEntries}
                              forceExpandedOnMobile={
                                forceExpandedMobileComposer && isDraftHeroState
                              }
                              projectSelectionRequired={
                                isLocalDraftThread && activeProject === null
                              }
                              phase={phase}
                              isCompacting={isCompacting}
                              canInterrupt={canInterruptRunningThread}
                              isSendBusy={
                                (isSendBusy && !sendQueuesBehindSetup) ||
                                (setupQueueSendThreadKey !== null &&
                                  setupQueueSendThreadKey === activeThreadKey) ||
                                queuedRunEdit.isSaving ||
                                isResuming
                              }
                              canResume={resumableRunId !== null || hasHeldQueuedRuns}
                              isRevertingCheckpoint={isRevertingCheckpoint}
                              sendDisabledReason={
                                !canOperateThread
                                  ? "This connection cannot change threads."
                                  : isEnvironmentChanging
                                    ? "Preparing machine"
                                    : isRevertingCheckpoint
                                      ? "Rewinding conversation"
                                      : feedbackUploading
                                        ? "Sending feedback"
                                        : threadDetailLoading
                                          ? "Messages loading"
                                          : worktreeSetupBlocksSend
                                            ? "Preparing worktree"
                                            : projectCloneSendBlockReason
                              }
                              isPreparingWorktree={isPreparingWorktree && !sendQueuesBehindSetup}
                              bannerItems={
                                isDraftHeroState || composerBannerItems.length === 0
                                  ? EMPTY_COMPOSER_BANNER_ITEMS
                                  : composerBannerItems
                              }
                              resumeCompactionTokens={resumeCompactionTokens}
                              keepFullHistory={keepFullHistory}
                              onToggleKeepFullHistory={toggleKeepFullHistoryStable}
                              sideChatAvailable={sideChat.available}
                              sideChatDisabledReason={sideChatDisabledReason}
                              onUsageLimitsCommand={
                                usageLimitsOffered &&
                                usageLimitsKey !== null &&
                                !composerHasNonPromptContent
                                  ? openUsageLimits
                                  : undefined
                              }
                              environmentUnavailable={activeEnvironmentUnavailableState}
                              activePendingApproval={activePendingApproval}
                              pendingApprovals={pendingApprovals}
                              onHeldRequestIdsChange={onHeldRequestIdsChange}
                              pendingUserInputs={pendingUserInputs}
                              activePendingProgress={activePendingProgress}
                              activePendingResolvedAnswers={activePendingResolvedAnswers}
                              activePendingIsResponding={activePendingIsResponding}
                              activePendingDraftAnswers={activePendingDraftAnswers}
                              activePendingQuestionIndex={activePendingQuestionIndex}
                              respondingRequestIds={respondingRequestIds}
                              showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                              activeProposedPlan={activeProposedPlan}
                              threadSyncPhase={
                                activeEnvironmentUnavailable ? null : threadSyncPhase
                              }
                              runtimeMode={runtimeMode}
                              defaultRuntimeMode={defaultRuntimeMode}
                              interactionMode={interactionMode}
                              lockedProvider={modelPickerLockedProvider}
                              providerStatuses={providerStatuses as ServerProvider[]}
                              providerCatalogKnown={serverConfig !== null}
                              activeProjectDefaultModelSelection={
                                activeProjectDefaultModelSelection
                              }
                              activeThreadModelSelection={activeThread?.modelSelection}
                              activeProjectId={activeProject?.id ?? null}
                              contextWindowEntries={serverVisibleTurnItems}
                              contextWindowLiveUsage={activeThreadLiveTokenUsage}
                              contextWindowProviderThread={activeProviderThread}
                              compactThreadUnavailable={compactThreadUnavailable}
                              compactDisabled={compactDisabled}
                              compactDisabledReason={compactDisabledReason}
                              resolvedTheme={resolvedTheme}
                              settings={settings}
                              keybindings={keybindings}
                              terminalOpen={Boolean(terminalUiState.terminalOpen)}
                              gitCwd={gitCwd}
                              pullRequestProjectId={
                                supportsPullRequests ? (activeProject?.id ?? null) : null
                              }
                              pullRequestRepository={
                                supportsPullRequests ? activeProjectRepository : null
                              }
                              threadPullRequests={(activeThreadShell ?? activeThread)?.pullRequests}
                              onComposerOverlayHeightChange={publishComposerOverlayHeightStable}
                              permissionsShownInStrip={showComposerContextStrip && !isServerThread}
                              promptRef={promptRef}
                              composerImagesRef={composerImagesRef}
                              composerFilesRef={composerFilesRef}
                              composerTerminalContextsRef={composerTerminalContextsRef}
                              onPageScrollKeyDown={onComposerPageScrollKeyDownStable}
                              onPageScrollKeyUp={onComposerPageScrollKeyUpStable}
                              onPageScrollRelease={onComposerPageScrollReleaseStable}
                              onCompactContext={onComposerCompactContextStable}
                              onSend={onComposerSendStable}
                              onResume={onComposerResumeStable}
                              onInterrupt={onInterruptStable}
                              onImplementPlanInNewThread={onImplementPlanInNewThreadStable}
                              onSelectActivePendingUserInputOption={
                                onSelectActivePendingUserInputOptionStable
                              }
                              onAdvanceActivePendingUserInput={
                                onAdvanceActivePendingUserInputStable
                              }
                              onDismissActivePendingUserInput={onDismissUserInputStable}
                              onPreviousActivePendingUserInputQuestion={
                                onPreviousActivePendingUserInputQuestionStable
                              }
                              onChangeActivePendingUserInputCustomAnswer={
                                onChangeActivePendingUserInputCustomAnswer
                              }
                              onProviderModelSelect={onProviderModelSelectStable}
                              onOpenProviderSetup={openProviderSetupStable}
                              getModelDisabledReason={getModelDisabledReason}
                              toggleInteractionMode={toggleInteractionModeStable}
                              handleRuntimeModeChange={handleRuntimeModeChangeStable}
                              handleInteractionModeChange={handleInteractionModeChangeStable}
                              focusComposer={focusComposerStable}
                              scheduleComposerFocus={scheduleComposerFocusStable}
                              setThreadError={setThreadError}
                              onExpandImage={onExpandTimelineImageStable}
                              onFileOpen={openFileAttachmentStable}
                              editingQueuedAttachments={queuedRunEdit.editingAttachments}
                              onRemoveEditingQueuedAttachment={
                                queuedRunEdit.removeEditingAttachment
                              }
                            />
                          )}
                        </div>
                      </ComposerSurface.Host>
                      <div className="min-h-0">
                        <div
                          data-terminal-open={terminalUiState.terminalOpen ? "true" : undefined}
                          className="relative z-0"
                        >
                          {showComposerContextStrip && (
                            <div className="pointer-events-auto">
                              <BranchToolbar
                                forceNewWorktree={multipleModelSelections !== null}
                                ref={branchToolbarRef}
                                environmentId={activeThread.environmentId}
                                threadId={activeThread.id}
                                projectId={activeThread.projectId}
                                worktreePath={activeThread.worktreePath}
                                isServerThread={isServerThread}
                                showGitControls={isGitRepo}
                                {...(routeKind === "draft" && draftId ? { draftId } : {})}
                                onEnvModeChange={onEnvModeChangeStable}
                                startFromOrigin={startFromOrigin}
                                onStartFromOriginChange={onStartFromOriginChange}
                                envMode={envMode}
                                {...(canOverrideServerThreadEnvMode
                                  ? {
                                      activeThreadBranchOverride: activeThreadBranch,
                                      onActiveThreadBranchOverrideChange:
                                        setPendingServerThreadBranch,
                                    }
                                  : {})}
                                envLocked={envLocked}
                                onComposerFocusRequest={scheduleComposerFocusStable}
                                {...(canCheckoutPullRequestIntoThread
                                  ? { onCheckoutPullRequestRequest: openPullRequestDialogStable }
                                  : {})}
                                {...(canChangeEnvironment
                                  ? { onEnvironmentChange: onEnvironmentChangeStable }
                                  : {})}
                                autoEnvironmentLabel={autoEnvironmentLabel}
                                onAutoEnvironment={
                                  draftId &&
                                  !envLocked &&
                                  canAutoBalanceEnvironments &&
                                  loadBalancingSettings.loadBalancingEnabled
                                    ? onAutoEnvironmentStable
                                    : undefined
                                }
                                availableEnvironments={logicalProjectEnvironments}
                                {...(isServerThread
                                  ? {}
                                  : {
                                      trailing: (
                                        <ComposerContextPermissions
                                          environmentId={environmentId}
                                          runtimeMode={runtimeMode}
                                          supportedRuntimeModes={
                                            activeProviderStatus?.supportedRuntimeModes
                                          }
                                          onRuntimeModeChange={handleRuntimeModeChangeStable}
                                        />
                                      ),
                                    })}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                      {isDraftHeroState && composerBannerItems.length > 0 ? (
                        // Out of flow, like the headline, so a notice never moves the centered composer.
                        <div className="absolute inset-x-0 top-full flex flex-col gap-1 pt-4">
                          <ComposerBannerStack items={composerBannerItems} detached />
                        </div>
                      ) : null}
                    </ComposerSurface.Shell>
                    <div
                      aria-hidden
                      className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                    />
                  </div>
                </div>
              </div>
            </div>
  );
}
