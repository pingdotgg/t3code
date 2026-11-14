
import { useComposerDraftAttachments } from "./useComposerDraftAttachments";
import { useComposerProviderModelState } from "./useComposerProviderModelState";
import { useComposerCommandState } from "./useComposerCommandState";
import { useComposerSessionSync } from "./useComposerSessionSync";
import { useComposerPromptEditing } from "./useComposerPromptEditing";
import { useComposerSubmissionState } from "./useComposerSubmissionState";
import { useComposerSurfaceLayout } from "./useComposerSurfaceLayout";
import { useComposerInputHandlers } from "./useComposerInputHandlers";
import { useComposerDragState } from "./useComposerDragState";
import { useComposerHandle } from "./useComposerHandle";
import type { ChatComposerProps } from "./chatComposerTypes";

export type { ChatComposerHandle, ChatComposerProps } from "./chatComposerTypes";

import { memo, use } from "react";

import { composerRequiresModifier } from "../../composer-logic";
import { DEFAULT_COMPOSER_PLACEHOLDER } from "../../composerPlaceholder";

import { isInsideCollapsedComposerControls, isInsideRestingComposerControlScope } from "./composerEventScope";

import { ComposerStashBadge } from "./ComposerStashBadge";
import { ComposerStashMenu } from "./ComposerStashMenu";

import { ComposerBanner } from "./ComposerBanner";
import { ComposerSurface } from "./ComposerSurface";
import { ComposerBannerStack } from "./ComposerBannerStack";

import { shortcutLabelForCommand } from "../../keybindings";

import { ComposerPromptEditorTiptap as ComposerPromptEditor } from "../ComposerPromptEditorTiptap";
import { ComposerContextActionsContext } from "../composerContextPresentation";

import { threadContextDropTargetProps } from "./threadContextDrag";

import { ComposerCommandMenu, composerSuggestionOptionId } from "./ComposerCommandMenu";
import { ComposerFilePreviewDialog, ComposerQueuedAttachmentRow } from "./ComposerAttachmentStrip";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerFooterPrimaryActions } from "./ComposerFooterControls";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";

import { cn } from "~/lib/utils";

import { ComposerPromptLengthValidation } from "./ComposerPromptLengthValidation";

import { PlayIcon } from "lucide-react";

import { proposedPlanTitle } from "@t3tools/shared/proposedPlanText";

import { ComposerCommandMenuLayer } from "./ComposerCommandMenuLayer";

export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const {
    canOperateThread,
    routeKind,
    routeThreadRef,
    activeThread,
    projectSelectionRequired,
    phase,
    canInterrupt,
    isSendBusy,
    canResume,
    isPreparingWorktree,
    isCompacting,
    environmentUnavailable,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    respondingRequestIds,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    compactDisabled,
    compactDisabledReason,
    resolvedTheme,
    settings,
    keybindings,
    terminalOpen,
    gitCwd,
    onPageScrollKeyDown,
    onPageScrollKeyUp,
    onPageScrollRelease,
    onCompactContext,
    onResume,
    onInterrupt,
    onImplementPlanInNewThread,
    onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput,
    onDismissActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
    editingQueuedAttachments,
    onRemoveEditingQueuedAttachment,
  } = props;
const s1 = useComposerDraftAttachments(props);
const { activeContextWindow, primaryEnvironmentId, composerDraftTargetKey, heldRequestIds, onTypingGuardDraftChange, onTypingGuardFocus, onTypingGuardBlur, onTypingGuardSend, activePendingApproval, pendingUserInputs, activePendingProgress, activePendingIsResponding, isLiteralPendingAnswer, isEditingQueuedMessage, composerDraft, composerDraftTargetKeyRef, questionAttachmentTarget, attachmentDraftTarget, attachmentTargetKey, attachmentTargetKeyRef, questionPreparations, prompt, composerImages, composerFiles, composerVideos, composerOtherFiles, composerTerminalContexts, composerPreviewAnnotations, composerReviewComments, composerThreadContexts, composerEnvironmentContexts, pendingSnapShotAnimations, pendingSnapShotIds, uncommittedSnapShotIds, standaloneComposerImages, preparingComposerImages, nonPersistedComposerImageIds, uploadsByImageId, setPreviewFileId, previewFile, composerContextActions, composerContextRecords, fileStagingLimit, attachmentBlockReason, setComposerDraftPrompt, addComposerDraftImages, removeComposerDraftImage, addComposerDraftFiles, removeComposerDraftFile, insertComposerDraftTerminalContext, setComposerDraftTerminalContexts, removeComposerDraftPreviewAnnotation, removeComposerDraftReviewComment, clearComposerDraftPersistedAttachments, syncComposerDraftPersistedAttachments, getComposerDraft } = s1;

const s2 = useComposerProviderModelState(props, { s1 });
const { providerInstanceEntries, lockedContinuationGroupKey, selectedInstanceId, selectedProvider, selectedProviderModels, composerModelOptions, selectedModel, composerProviderState, noProviderAvailable, providerCatalogPending, showProviderUnavailable, providerSetupInstanceId, resolvedCompactDisabledReason, compatibleRuntimeMode, compatibleRuntimeModeOptions, runtimeModeCeilingDenial, runtimeModeCeilingFallback, providerSendBlockReason, sendDisabledReason, isSendDisabled, compactCommandAvailable, selectedProviderSkills, selectedProviderSlashCommands, refreshWorkspaceSnapshotOnTyping, workspaceSkillsScanning, selectedPromptEffort, planModeUiEnabled, interactionMode, selectedModelSelection, modelOptionsByInstance, selectedModelForPickerWithCustomFallback, activeThreadModelDisplayName, reserveContextWindowMeter, composerCursor, setComposerCursor, composerTrigger, setComposerTrigger, resolveComposerTrigger, dismissComposerTrigger, resetComposerTrigger, composerHighlightedItemId, setComposerHighlightedItemId, composerSuggestionListId, promptHistoryPositionRef, composerHighlightedSearchKey, setComposerHighlightedSearchKey, isDragOverComposer, setIsDragOverComposer, isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact, isComposerModelPickerOpen, setIsComposerModelPickerOpen, isMobileViewport, isSoftwareKeyboardOpen, setIsComposerFocused, composerSubmissionError, setComposerSubmissionError, providerInputSubmissionError, setProviderInputSubmissionError, composerMenuAnchor, setComposerMenuAnchor, observeWrappedPrompt, isComposerCollapsedMobile, composerEditorRef, pasteAsTextShortcutUntilRef, composerFormRef, composerSurfaceRef, providerInputRejectedRef, composerSelectLockRef, composerMenuOpenRef, composerMenuItemsRef, activeComposerMenuItemRef, composerBlurFrameRef, mobileComposerExpandFrameRef, mobileComposerExpandReleaseFrameRef, mobileComposerExpandInFlightRef, pendingThreadImportsRef, isRevertingCheckpointRef } = s2;

const s3 = useComposerCommandState(props, { s1, s2 });
const { composerSendState, composerTriggerKind, linkedEnvironments, composerMenuItems, isComposerMenuLoading, composerMenuEmptyState, composerMenuOpen, composerMenuSearchKey, activeComposerMenuItemId, activeComposerMenuItem, isComposerApprovalState, followUpBehavior, composerSuggestionsVisible, composerSuggestionListVisible, activePendingUserInput, isChoiceOnlyPendingQuestion, showComposerTopDrawer, showCollapsedMobilePromptRow, showComposerAttachAction, composerFooterHasWideActions, editPromptFromTraitsStable, promptUltrathink, setInlineRestingControlsHost, restingComposerControlsRef, attachRestingComposerControls, restingControlsHiddenBlockCount, restingControlsIconOnlyBlockCount, restingControlsVisible, attachExpandedComposerControls, expandedControlsHiddenBlockCount, expandedControlsIconOnlyBlockCount, pendingPrimaryAction, showResumeAction, collapsedComposerPrimaryActionDisabled, collapsedComposerPrimaryActionLabel, showMobilePendingAnswerActions, setPrompt, addComposerImage, addComposerImagesToDraft, addComposerFilesToDraft, removeComposerImageFromDraft, removeComposerFileFromDraft, addComposerDraftReviewComment, addComposerDraftPreviewAnnotation, addComposerDraftThreadContexts, setComposerDraftThreadContexts, addComposerDraftEnvironmentContexts, setComposerDraftEnvironmentContexts, buildContextClipboardFragment, buildContextClipboardFragmentStable, loadThreadTranscript, countReservedAttachments, countReservedAttachmentsStable, importContextRecords, importContextFragment, importContextFragmentStable } = s3;

const s4 = useComposerSessionSync(props, { s1, s2, s3 });
const { retainedContextPayloads } = s4;

const s5 = useComposerPromptEditing(props, { s1, s2, s3, s4 });
const { onPromptChangeStable, applyPromptReplacement, applyPromptReplacementStable, readComposerSnapshot, readComposerSnapshotStable, resolveActiveComposerTrigger } = s5;

const s6 = useComposerSubmissionState(props, { s1, s2, s3, s5 });
const { onSelectComposerItemStable, onComposerMenuItemHighlightedStable, submitComposer, submitComposerStable, handleSubmitMessageStable, submitCitationAndSendStable, saveCitationDraftToPromptStable, compactThreadContextStable, expandMobileComposer, expandMobileComposerStable, onComposerCommandKey } = s6;

const s7 = useComposerSurfaceLayout(props, { s1, s2, s3, s6 });
const { stashQueue, isStashMenuOpen, setIsStashMenuOpen, stashPulseKey, restoreStashEntryStable, deleteStashEntryStable, toggleStashMenuStable, composerControlsCollapsed, showInlineRestingControls, composerControlsHidden, collapsedComposerImagePreviews, composerMainSurfaceRef, composerControls, shelfItems } = s7;

const s8 = useComposerInputHandlers(props, { s1, s2, s3, s5, s6 });
const { insertComposerTextStable, addComposerAttachments, removeComposerImage, foldPastedText, onComposerCommandKeyStable, isPathQueryActiveStable, insertComposerTextAtEndStable, addComposerFoldersStable, onComposerPasteStable } = s8;

  // Capture drops before the editor; mention handlers own native propagation and moves.
const s9 = useComposerDragState(props, { s1, s2, s3, s5, s6, s8 });
const { composerMentionDragHandlers, onComposerMentionDragLeaveCapture, handleInterruptPrimaryActionStable, handleImplementPlanInNewThreadPrimaryActionStable, scheduleComposerCollapseCheck } = s9;

const s10 = useComposerHandle(props, { s1, s2, s3, s5, s6, s7, s8 });
const { composerAttachmentMediaRow, composerAttachmentFileList, composerAttachButton } = s10;
  return (
    <form
      ref={composerFormRef}
      onSubmit={submitComposerStable}
      onFocusCapture={(event) => {
        const activeElement = event.target;
        if (
          activeElement instanceof Element &&
          activeElement.closest('[data-testid="composer-editor"]')
        ) {
          onTypingGuardFocus();
        }
        if (composerControlsCollapsed && isInsideRestingComposerControlScope(activeElement)) {
          return;
        }
        if (isInsideCollapsedComposerControls(activeElement)) {
          return;
        }
        if (composerBlurFrameRef.current !== null) {
          window.cancelAnimationFrame(composerBlurFrameRef.current);
          composerBlurFrameRef.current = null;
        }
        setIsComposerFocused(true);
      }}
      onBlurCapture={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[data-testid="composer-editor"]')
        ) {
          onTypingGuardBlur();
        }
        scheduleComposerCollapseCheck();
      }}
      onDragEnterCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        composerMentionDragHandlers.onDragEnter(event);
      }}
      onDragOverCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        composerMentionDragHandlers.onDragOver(event);
      }}
      onDragLeaveCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        onComposerMentionDragLeaveCapture(event);
      }}
      onDropCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        composerMentionDragHandlers.onDrop(event);
      }}
      className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width)"
      data-chat-composer-form="true"
      {...threadContextDropTargetProps()}
    >
      <ComposerBanner.Dock>
        <ComposerBanner.Column>
          <ComposerBannerStack items={shelfItems} />
          {showComposerTopDrawer ? (
            <ComposerBanner.Attachment>
              <ComposerBanner.Root data-chat-composer-top-drawer="true" variant="info">
                {pendingUserInputs.length > 0 ? (
                  <ComposerPendingUserInputPanel
                    pendingUserInputs={pendingUserInputs}
                    cwd={gitCwd ?? undefined}
                    threadRef={routeThreadRef}
                    disabled={!canOperateThread}
                    respondingRequestIds={
                      activePendingIsResponding && activePendingUserInput
                        ? [...respondingRequestIds, activePendingUserInput.requestId]
                        : respondingRequestIds
                    }
                    answers={activePendingDraftAnswers}
                    questionIndex={activePendingQuestionIndex}
                    onToggleOption={onSelectActivePendingUserInputOption}
                    onAdvance={onAdvanceActivePendingUserInput}
                    onDismiss={onDismissActivePendingUserInput}
                  />
                ) : !isComposerCollapsedMobile && showPlanFollowUpPrompt && activeProposedPlan ? (
                  <ComposerPlanFollowUpBanner
                    key={activeProposedPlan.id}
                    planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                  />
                ) : null}
              </ComposerBanner.Root>
            </ComposerBanner.Attachment>
          ) : null}
        </ComposerBanner.Column>
        <ComposerStashBadge
          count={stashQueue.length}
          menuOpen={isStashMenuOpen}
          pulseKey={stashPulseKey}
          onToggleMenu={toggleStashMenuStable}
        />
      </ComposerBanner.Dock>
      <div className="relative">
        <ComposerSurface.Main
          ref={composerMainSurfaceRef}
          data-inline-resting-controls="true"
          className={composerProviderState.composerFrameClassName}
        >
          <div
            ref={composerSurfaceRef}
            data-chat-composer-surface="true"
            data-chat-composer-mobile-collapsed={isComposerCollapsedMobile ? "true" : "false"}
            className={cn(
              "rounded-2xl transition-[background-color] duration-200",
              "in-data-[thread-context-over]:bg-accent/45 in-data-[thread-context-over]:ring-1 in-data-[thread-context-over]:ring-inset in-data-[thread-context-over]:ring-primary/70",
              isDragOverComposer ? "bg-accent/45 ring-1 ring-inset ring-primary/70" : null,
              projectSelectionRequired ? "opacity-75" : null,
              composerProviderState.composerSurfaceClassName,
            )}
          >
            {showCollapsedMobilePromptRow ? (
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <button
                  type="button"
                  data-chat-composer-transition-prompt="true"
                  className={cn(
                    "min-w-0 flex-1 truncate bg-transparent p-0 text-left text-sm focus:outline-none",
                    prompt.trim() ? "text-foreground" : "text-placeholder",
                  )}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={expandMobileComposerStable}
                  aria-label="Expand composer"
                >
                  {prompt.trim() ||
                    (showProviderUnavailable ? "Enable a provider in Settings" : "Ask anything...")}
                </button>
                {collapsedComposerImagePreviews}
                <button
                  type="button"
                  data-chat-composer-transition-actions="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover disabled:opacity-64"
                  disabled={collapsedComposerPrimaryActionDisabled}
                  aria-label={collapsedComposerPrimaryActionLabel}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (showResumeAction) onResume();
                    else if (props.resumeCompactionTokens !== null && !props.keepFullHistory)
                      expandMobileComposer();
                    else submitComposer();
                  }}
                >
                  {showResumeAction ? (
                    <PlayIcon className="size-4 fill-current" aria-hidden="true" />
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path
                        d="M8 3L8 13M8 3L4 7M8 3L12 7"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              </div>
            ) : null}

            <div
              ref={(node) => {
                setComposerMenuAnchor(node);
                const stopObserving = observeWrappedPrompt(node);
                return () => {
                  setComposerMenuAnchor(null);
                  stopObserving?.();
                };
              }}
              data-chat-composer-body="true"
              className={cn(
                "relative px-4 pb-2",
                "pt-3.5 sm:pt-4",
                isComposerCollapsedMobile && "hidden",
              )}
            >
              {isStashMenuOpen && !composerMenuOpen && (
                <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                  <ComposerStashMenu
                    composerFormRef={composerFormRef}
                    entries={stashQueue}
                    stashShortcutLabel={shortcutLabelForCommand(keybindings, "composer.stash", {
                      context: {
                        terminalFocus: false,
                        terminalOpen,
                        modelPickerOpen: false,
                      },
                    })}
                    onRestore={restoreStashEntryStable}
                    onDelete={deleteStashEntryStable}
                    onClose={() => setIsStashMenuOpen(false)}
                  />
                </ComposerCommandMenuLayer>
              )}

              <div role="status" aria-atomic="true" className="sr-only">
                {composerSuggestionsVisible && composerMenuItems.length === 0
                  ? isComposerMenuLoading
                    ? composerTriggerKind === "pull-request"
                      ? "Finding pull request..."
                      : composerTriggerKind === "skill" || composerTriggerKind === "slash-command"
                        ? "Searching workspace skills..."
                        : "Searching workspace files..."
                    : composerMenuEmptyState
                  : ""}
              </div>
              {composerSuggestionsVisible && (
                <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                  <ComposerCommandMenu
                    listId={composerSuggestionListId}
                    items={composerMenuItems}
                    resolvedTheme={resolvedTheme}
                    isLoading={isComposerMenuLoading}
                    triggerKind={composerTriggerKind}
                    emptyStateText={composerMenuEmptyState}
                    activeItemId={activeComposerMenuItem?.id ?? null}
                    onHighlightedItemChange={onComposerMenuItemHighlightedStable}
                    onSelect={onSelectComposerItemStable}
                  />
                </ComposerCommandMenuLayer>
              )}

              {!isComposerCollapsedMobile &&
                pendingUserInputs.length === 0 &&
                editingQueuedAttachments !== null &&
                editingQueuedAttachments.length > 0 && (
                  <ComposerQueuedAttachmentRow
                    attachments={editingQueuedAttachments}
                    onRemove={onRemoveEditingQueuedAttachment}
                  />
                )}

              {composerAttachmentMediaRow}

              {composerAttachmentFileList}

              <div className="relative">
                {previewFile ? (
                  <ComposerFilePreviewDialog
                    file={previewFile}
                    onRemove={removeComposerFileFromDraft}
                    onPreviewFileIdChange={setPreviewFileId}
                  />
                ) : null}
                <ComposerContextActionsContext value={composerContextActions}>
                  <ComposerPromptEditor
                    draftKey={composerDraftTargetKey}
                    // Switching threads lands focus here, so the label names the thread.
                    ariaLabel={activeThread ? `Message ${activeThread.title}` : "Message"}
                    suggestionListId={composerSuggestionListId}
                    activeSuggestionId={
                      composerSuggestionListVisible && activeComposerMenuItem
                        ? composerSuggestionOptionId(
                            composerSuggestionListId,
                            activeComposerMenuItem.id,
                          )
                        : undefined
                    }
                    editorRef={composerEditorRef}
                    richTextEnabled={settings.composerRichTextEnabled}
                    literalText={isLiteralPendingAnswer}
                    isPathQueryActive={isPathQueryActiveStable}
                    value={activePendingProgress ? activePendingProgress.customAnswer : prompt}
                    cursor={composerCursor}
                    contextRecords={composerContextRecords}
                    buildContextClipboardFragment={buildContextClipboardFragmentStable}
                    importContextFragment={importContextFragmentStable}
                    skills={selectedProviderSkills}
                    className={cn(showMobilePendingAnswerActions && "max-sm:pb-12")}
                    onChange={onPromptChangeStable}
                    onCommandKeyDown={onComposerCommandKeyStable}
                    onPageScrollKeyDown={onPageScrollKeyDown}
                    onPageScrollKeyUp={onPageScrollKeyUp}
                    onPageScrollRelease={onPageScrollRelease}
                    onCitationSubmitAndSend={submitCitationAndSendStable}
                    onCitationDraftSave={saveCitationDraftToPromptStable}
                    onPaste={onComposerPasteStable}
                    placeholder={
                      isComposerApprovalState
                        ? activePendingApproval?.supportsFeedback
                          ? "Send feedback to decline this request"
                          : "Send a message to decline and redirect the agent"
                        : activePendingProgress
                          ? isChoiceOnlyPendingQuestion
                            ? "Choose an option above"
                            : "Type your own answer, or leave this blank to use the selected option"
                          : showPlanFollowUpPrompt && activeProposedPlan
                            ? "Add feedback to refine the plan, or leave this blank to implement it"
                            : projectSelectionRequired
                              ? "Choose a project above to start a thread"
                              : showProviderUnavailable
                                ? "Enable a provider in Settings to send a message"
                                : DEFAULT_COMPOSER_PLACEHOLDER
                    }
                    disabled={
                      projectSelectionRequired ||
                      isChoiceOnlyPendingQuestion ||
                      activePendingIsResponding
                    }
                  />
                </ComposerContextActionsContext>
                {showMobilePendingAnswerActions ? (
                  <div
                    data-chat-composer-mobile-pending-actions="true"
                    className="absolute bottom-0 right-0 flex items-center justify-end gap-1"
                  >
                    <ComposerPrimaryActions
                      compact
                      canOperateThread={canOperateThread}
                      pendingAction={pendingPrimaryAction}
                      isRunning={false}
                      canInterrupt={false}
                      showPlanFollowUpPrompt={false}
                      promptHasText={false}
                      isSendBusy={isSendBusy}
                      sendDisabledReason={sendDisabledReason}
                      isEnvironmentUnavailable={
                        environmentUnavailable !== null ||
                        noProviderAvailable ||
                        projectSelectionRequired
                      }
                      isPreparingWorktree={false}
                      hasSendableContent={false}
                      preserveComposerFocusOnPointerDown
                      onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                      onInterrupt={handleInterruptPrimaryActionStable}
                      onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryActionStable}
                    />
                  </div>
                ) : null}
              </div>
            </div>

            <ComposerPromptLengthValidation
              message={providerInputSubmissionError ?? composerSubmissionError}
            />

            {isComposerCollapsedMobile ? null : (
              <div
                data-chat-composer-footer="true"
                className={cn(
                  "flex min-w-0 flex-nowrap items-center overflow-visible px-2 pb-2",
                  pendingUserInputs.length > 0 && "pt-2",
                  showMobilePendingAnswerActions && "hidden sm:flex",
                )}
              >
                {composerAttachButton ? <div className="me-2">{composerAttachButton}</div> : null}
                <div
                  data-chat-composer-actions="right"
                  data-chat-composer-transition-actions="true"
                  data-chat-composer-primary-actions-compact={
                    isComposerPrimaryActionsCompact ? "true" : "false"
                  }
                  className="flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-2"
                >
                  <div
                    ref={attachExpandedComposerControls}
                    data-chat-composer-controls="footer"
                    data-chat-composer-footer-controls="true"
                    className="relative flex min-w-0 flex-1 items-center justify-end gap-0.5"
                  >
                    {composerControls}
                  </div>
                  <ComposerFooterPrimaryActions
                    compact={isComposerPrimaryActionsCompact}
                    canOperateThread={canOperateThread}
                    activeContextWindow={
                      settings.contextWindowMeterEnabled ? activeContextWindow : null
                    }
                    reserveContextWindowMeter={reserveContextWindowMeter}
                    activeThreadModelDisplayName={activeThreadModelDisplayName}
                    pendingAction={pendingPrimaryAction}
                    isRunning={phase === "running"}
                    canInterrupt={canInterrupt}
                    followUpBehavior={followUpBehavior}
                    canSteer={!isCompacting}
                    alternateShortcutLabel={shortcutLabelForCommand(
                      keybindings,
                      "composer.sendAlternate",
                      {
                        context: {
                          composerFocus: true,
                          draftThreadRoute: routeKind === "draft",
                          turnRunning: true,
                          composerRequiresModifier: composerRequiresModifier(
                            settings.sendShortcut,
                            prompt,
                          ),
                        },
                      },
                    )}
                    showPlanFollowUpPrompt={
                      pendingUserInputs.length === 0 && showPlanFollowUpPrompt
                    }
                    promptHasText={prompt.trim().length > 0}
                    isSendBusy={isSendBusy}
                    sendDisabledReason={sendDisabledReason}
                    isEnvironmentUnavailable={
                      environmentUnavailable !== null ||
                      noProviderAvailable ||
                      projectSelectionRequired
                    }
                    isPreparingWorktree={isPreparingWorktree}
                    hasSendableContent={composerSendState.hasSendableContent}
                    canResume={showResumeAction}
                    preserveComposerFocusOnPointerDown={isMobileViewport}
                    isEditingQueuedMessage={isEditingQueuedMessage}
                    onSubmitMessage={handleSubmitMessageStable}
                    onResume={onResume}
                    onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                    onInterrupt={handleInterruptPrimaryActionStable}
                    onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryActionStable}
                    compactBeforeSendTokens={props.resumeCompactionTokens}
                    keepFullHistory={props.keepFullHistory}
                    onToggleKeepFullHistory={props.onToggleKeepFullHistory}
                    compactDisabled={compactDisabled || noProviderAvailable || isSendBusy}
                    compactDisabledReason={resolvedCompactDisabledReason}
                    {...(compactCommandAvailable
                      ? { onCompactContext: compactThreadContextStable }
                      : {})}
                  />
                </div>
              </div>
            )}
            {showInlineRestingControls ? (
              <div className="h-8">
                <div
                  ref={setInlineRestingControlsHost}
                  className="absolute bottom-2 inset-x-4 min-w-0"
                >
                  <div
                    ref={attachRestingComposerControls}
                    data-chat-composer-resting-controls="true"
                    aria-hidden={restingControlsVisible ? undefined : true}
                    inert={restingControlsVisible ? undefined : true}
                    className={cn(
                      "relative flex w-max min-w-0 max-w-full items-center gap-1 text-muted-foreground/70 [&_button]:text-xs!",
                      !restingControlsVisible && "invisible",
                    )}
                  >
                    {composerControls}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </ComposerSurface.Main>
      </div>
    </form>
  );
});
