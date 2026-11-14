import type { ChatComposerProps } from "./chatComposerTypes";
import { useComposerDraftAttachments } from "./useComposerDraftAttachments";
import { useComposerProviderModelState } from "./useComposerProviderModelState";

import {
  deriveComposerSendState,
  getAntigravitySendBlockReason,
  resolveComposerInteractionMode,
  threadShellHasStarted,
} from "../ChatView.logic";
import { useLinkedEnvironments } from "~/state/peerLinks";
import { useComposerMenuItems } from "./useComposerMenuItems";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import {
  memo,
  use,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  type ComposerSubmissionIntent,
  collapseExpandedComposerCursor,
  composerRequiresModifier,
  composerStateAtPromptEnd,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  formatAssistantCitationForComposer,
  isPathSuggestionCurrent,
  extendReplacementRangeForTrailingSpace,
  replaceTextRange,
} from "../../composer-logic";
import { useStableCallback } from "../../hooks/useStableCallback";
import { readPromptUltrathink } from "./TraitsPicker";
import { useRestingComposerControlsLayout } from "./useRestingComposerControlsLayout";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  composerFileNeedsReattach,
  composerDraftHasUserContent,
  composerTargetKey,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../../composerDraftStore";
import {
  releaseAttachmentUpload,
  releaseDraftAttachment,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import {
  attachmentContextRecord,
  uploadedAttachmentContextRecord,
  previewAnnotationContextId,
  previewAnnotationContextRecord,
  reviewCommentContextId,
  reviewCommentContextReference,
  reviewCommentContextRecord,
  terminalContextReference,
  terminalContextRecord,
  threadContextReference,
  environmentContextRecord,
  environmentContextReference,
} from "~/lib/composerContextRecords";
import {
  threadContextRecord,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import type { ComposerContextRecord, ThreadPullRequestLink } from "@t3tools/contracts";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import { rememberCopiedComposerAttachments } from "~/lib/copiedComposerAttachments";
import { useComposerContextImport } from "./useComposerContextImport";
import {
  getComposerPromptLengthValidationMessage,
  getComposerSubmissionValidationMessage,
  submitComposerDraft,
} from "./composerSubmission";
export function useComposerCommandState(props: ChatComposerProps, params: {
  s1: ReturnType<typeof useComposerDraftAttachments>,
  s2: ReturnType<typeof useComposerProviderModelState>,
  }) {
  const { s1, s2 } = params;
  const { editingQueuedAttachments, compactThreadUnavailable, environmentId, gitCwd, activeThreadId, pullRequestProjectId, pullRequestRepository, threadPullRequests, settings, pendingApprovals, showPlanFollowUpPrompt, activeProposedPlan, supportsQuestionAttachments, composerDraftTarget, promptRef, scheduleComposerFocus, activePendingResolvedAnswers, canResume, phase, isSendBusy, projectSelectionRequired, environmentUnavailable, composerFilesRef, activeThread, composerImagesRef, composerTerminalContextsRef } = props;
  const { prompt, composerImages, composerFiles, composerTerminalContexts, composerPreviewAnnotations, composerReviewComments, composerDraft, questionAttachmentTarget, activePendingApproval, heldRequestIds, pendingUserInputs, activePendingProgress, fileStagingLimit, getComposerDraft, setComposerDraftPrompt, attachmentBlockReason, questionPreparations, attachmentTargetKey, activePendingIsResponding, isEditingQueuedMessage, addComposerDraftImages, attachmentDraftTarget, addComposerDraftFiles, removeComposerDraftImage, removeComposerDraftFile, composerThreadContexts, composerEnvironmentContexts, uploadsByImageId, attachmentTargetKeyRef, composerContextRecords, isLiteralPendingAnswer } = s1;
  const { composerTrigger, planModeUiEnabled, selectedProvider, selectedProviderSkills, selectedProviderSlashCommands, workspaceSkillsScanning, composerSuggestionListId, composerHighlightedItemId, composerHighlightedSearchKey, composerMenuOpenRef, composerMenuItemsRef, activeComposerMenuItemRef, isComposerCollapsedMobile, setComposerCursor, setComposerTrigger, isSendDisabled, noProviderAvailable, isMobileViewport, pendingThreadImportsRef, composerSubmissionError, setComposerSubmissionError, selectedModel, selectedPromptEffort, setProviderInputSubmissionError } = s2;
    const composerSendState = deriveComposerSendState({
      prompt,
      imageCount: composerImages.length + composerFiles.length,
      existingAttachmentCount: editingQueuedAttachments?.length ?? 0,
      terminalContexts: composerTerminalContexts,
      elementContextCount: composerPreviewAnnotations.length + composerReviewComments.length,
    });
    const composerTriggerKind = composerTrigger?.kind ?? null;
    const compactSlashCommandAvailable =
      composerTrigger?.kind === "slash-command" &&
      prompt.slice(0, composerTrigger.rangeStart).trim() === "" &&
      !compactThreadUnavailable &&
      prompt.slice(composerTrigger.rangeEnd).trim() === "" &&
      composerImages.length + composerFiles.length === 0 &&
      composerDraft.persistedAttachments.length === 0 &&
      composerTerminalContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerReviewComments.length === 0;
    const linkedEnvironments = useLinkedEnvironments(environmentId);
    const {
      items: composerMenuItems,
      isLoading: isComposerMenuLoading,
      emptyState: composerMenuEmptyState,
    } = useComposerMenuItems({
      composerTrigger,
      environmentId,
      linkedEnvironments,
      gitCwd,
      activeThreadId,
      pullRequestProjectId,
      pullRequestRepository,
      threadPullRequests,
      planModeUiEnabled,
      sideChatAvailable: props.sideChatAvailable === true,
      sideChatDisabledReason: props.sideChatDisabledReason ?? null,
      compactSlashCommandAvailable,
      selectedProvider,
      selectedProviderSkills,
      selectedProviderSlashCommands,
      showSkillsInSlashMenu: settings.showSkillsInSlashMenu,
      workspaceSkillsScanning,
      questionAttachmentTarget,
    });

    const composerMenuOpen = Boolean(composerTrigger);
    const composerMenuSearchKey = composerTrigger
      ? `${composerSuggestionListId}:${composerTrigger.kind}:${composerTrigger.query.trim().toLowerCase()}`
      : null;
    const activeComposerMenuItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    const activeComposerMenuItem =
      composerMenuItems.find((item) => item.id === activeComposerMenuItemId) ?? null;

    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed composer menu state to refs read by editor key handlers
    useLayoutEffect(() => {
      composerMenuOpenRef.current = composerMenuOpen;
      composerMenuItemsRef.current = composerMenuItems;
      activeComposerMenuItemRef.current = activeComposerMenuItem;
    });

    const isComposerApprovalState = activePendingApproval !== null;
    // A send declines the approvals shown here to redirect the agent, so it steers the waiting
    // turn instead of queueing behind it. Approvals the typing guard holds stay unseen and pending.
    const followUpBehavior = pendingApprovals.some(
      (approval) => !heldRequestIds.has(approval.requestId),
    )
      ? "steer"
      : settings.followUpBehavior;
    const composerSuggestionsVisible = composerMenuOpen;
    const composerSuggestionListVisible = composerSuggestionsVisible && composerMenuItems.length > 0;
    const activePendingUserInput = pendingUserInputs[0] ?? null;
    const isChoiceOnlyPendingQuestion =
      activePendingProgress?.activeQuestion?.allowCustomAnswer === false;
    const showComposerTopDrawer =
      pendingUserInputs.length > 0 ||
      (!isComposerCollapsedMobile && showPlanFollowUpPrompt && activeProposedPlan !== null);
    const showCollapsedMobilePromptRow = isComposerCollapsedMobile;
    const showComposerAttachAction =
      fileStagingLimit !== null &&
      (!activePendingProgress ||
        (supportsQuestionAttachments &&
          activePendingProgress.activeQuestion?.allowCustomAnswer !== false));
    const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;

    const editPromptFromTraits = (edit: (prompt: string) => string) => {
      const currentPrompt = getComposerDraft(composerDraftTarget)?.prompt ?? "";
      const nextPrompt = edit(currentPrompt);
      if (nextPrompt === currentPrompt) return;
      if (nextPrompt === promptRef.current) {
        scheduleComposerFocus();
        return;
      }
      promptRef.current = nextPrompt;
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    };
    const editPromptFromTraitsStable = useStableCallback(editPromptFromTraits);
    const promptUltrathink = readPromptUltrathink(prompt);

    const [inlineRestingControlsHost, setInlineRestingControlsHost] = useState<HTMLDivElement | null>(
      null,
    );
    const {
      controlsRef: restingComposerControlsRef,
      attachControls: attachRestingComposerControls,
      hiddenBlockCount: restingControlsHiddenBlockCount,
      iconOnlyBlockCount: restingControlsIconOnlyBlockCount,
      controlsVisible: restingControlsVisible,
    } = useRestingComposerControlsLayout(inlineRestingControlsHost);
    const {
      attachControls: attachExpandedComposerControls,
      hiddenBlockCount: expandedControlsHiddenBlockCount,
      iconOnlyBlockCount: expandedControlsIconOnlyBlockCount,
    } = useRestingComposerControlsLayout(null, true);
    const pendingPrimaryAction = activePendingProgress
      ? {
          questionIndex: activePendingProgress.questionIndex,
          isLastQuestion: activePendingProgress.isLastQuestion,
          canAdvance:
            activePendingProgress.canAdvance &&
            !attachmentBlockReason &&
            !(questionPreparations[attachmentTargetKey] ?? 0),
          isResponding: activePendingIsResponding,
          isComplete: Boolean(activePendingResolvedAnswers),
        }
      : null;
    const showResumeAction =
      canResume && !composerDraftHasUserContent(composerDraft) && !isEditingQueuedMessage;
    const collapsedComposerPrimaryActionDisabled =
      phase === "running" ||
      isSendBusy ||
      isSendDisabled ||
      noProviderAvailable ||
      projectSelectionRequired ||
      environmentUnavailable !== null ||
      (!composerSendState.hasSendableContent && !showResumeAction);
    const collapsedComposerPrimaryActionLabel = showResumeAction
      ? "Resume thread"
      : props.resumeCompactionTokens !== null && !props.keepFullHistory
        ? "Open composer to compact and send"
        : "Send message";
    const showMobilePendingAnswerActions =
      isMobileViewport && !isComposerCollapsedMobile && pendingPrimaryAction !== null;

    const setPrompt = (nextPrompt: string) => {
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    };

    const addComposerImage = (image: ComposerImageAttachment) =>
      addComposerDraftImages(attachmentDraftTarget, [image]);

    const addComposerImagesToDraft = (images: ComposerImageAttachment[]) =>
      addComposerDraftImages(attachmentDraftTarget, images);

    const addComposerFilesToDraft = (files: ComposerFileAttachment[]) =>
      addComposerDraftFiles(attachmentDraftTarget, files, {
        appendReference: questionAttachmentTarget === null,
      });

    const removeComposerImageFromDraft = (imageId: string) => {
      if (questionAttachmentTarget && activePendingIsResponding) return;
      releaseAttachmentUpload(imageId);
      removeComposerDraftImage(attachmentDraftTarget, imageId);
    };

    const removeComposerFileFromDraft = (fileId: string) => {
      if (questionAttachmentTarget && activePendingIsResponding) return;
      // Hydrated uploads use persisted attachment ids, not queue keys.
      const file = composerFilesRef.current.find((candidate) => candidate.id === fileId);
      if (file) {
        releaseDraftAttachment(file);
      } else {
        releaseAttachmentUpload(fileId);
      }
      removeComposerDraftFile(attachmentDraftTarget, fileId);
    };

    const addComposerDraftReviewComment = useComposerDraftStore((store) => store.addReviewComment);
    const addComposerDraftPreviewAnnotation = useComposerDraftStore(
      (store) => store.addPreviewAnnotation,
    );
    const addComposerDraftThreadContexts = useComposerDraftStore((store) => store.addThreadContexts);
    const setComposerDraftThreadContexts = useComposerDraftStore((store) => store.setThreadContexts);
    const addComposerDraftEnvironmentContexts = useComposerDraftStore(
      (store) => store.addEnvironmentContexts,
    );
    const setComposerDraftEnvironmentContexts = useComposerDraftStore(
      (store) => store.setEnvironmentContexts,
    );
    const buildContextClipboardFragment = (contextIds: ReadonlyArray<string>): string | null => {
      const wanted = new Set(contextIds);
      const copiedFiles = new Map<string, File>();
      for (const annotation of composerPreviewAnnotations) {
        if (
          wanted.has(previewAnnotationContextId(annotation.id)) &&
          composerImages.some((image) => image.id === annotation.id)
        ) {
          wanted.add(toKindScopedComposerContextId("image", annotation.id));
        }
      }
      const records: ComposerContextRecord[] = [
        ...composerTerminalContexts
          .filter((c) => wanted.has(terminalContextReference(c).contextId))
          .map(terminalContextRecord),
        ...composerThreadContexts.filter((record) => wanted.has(record.contextId)),
        ...composerEnvironmentContexts.filter((record) => wanted.has(record.contextId)),
        ...composerReviewComments
          .filter((c) => wanted.has(reviewCommentContextId(c.id)))
          .map(reviewCommentContextRecord),
        ...composerPreviewAnnotations
          .filter((a) => wanted.has(previewAnnotationContextId(a.id)))
          .map((annotation) =>
            previewAnnotationContextRecord(annotation, {
              screenshotContextId: composerImages.some((image) => image.id === annotation.id)
                ? annotation.id
                : undefined,
            }),
          ),
        ...[...composerImages, ...composerFiles]
          .filter((attachment) =>
            wanted.has(toKindScopedComposerContextId(attachment.type, attachment.id)),
          )
          .flatMap((attachment) => {
            const record =
              uploadedAttachmentContextRecord(attachment, uploadsByImageId[attachment.id]) ??
              (attachment.file
                ? attachmentContextRecord({ attachment, attachmentId: attachment.id })
                : null);
            if (!record) return [];
            if (attachment.file) copiedFiles.set(record.attachmentId, attachment.file);
            return [record];
          }),
      ];
      if (records.length === 0) return null;
      const fragment = encodeComposerContextFragment({
        version: 1,
        source: { environmentId, ...(activeThread ? { threadId: activeThread.id } : {}) },
        records,
      });
      if (fragment) rememberCopiedComposerAttachments(environmentId, copiedFiles);
      return fragment;
    };
    const buildContextClipboardFragmentStable = useStableCallback(buildContextClipboardFragment);
    const {
      loadThreadTranscript,
      countReservedAttachments,
      countReservedAttachmentsStable,
      importContextRecords,
      importContextFragment,
      importContextFragmentStable,
    } = useComposerContextImport({
      environmentId,
      linkedEnvironments,
      activeThread,
      activeThreadId,
      composerDraftTarget,
      attachmentDraftTarget,
      attachmentTargetKey,
      attachmentTargetKeyRef,
      questionAttachmentTarget,
      pendingUserInputs,
      composerContextRecords,
      composerImages,
      composerFilesRef,
      promptRef,
      pendingThreadImportsRef,
      addComposerFilesToDraft,
    });

    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the shared prompt ref in step with the committed draft prompt for imperative handlers
    useEffect(() => {
      if (isLiteralPendingAnswer) return;
      promptRef.current = prompt;
    }, [isLiteralPendingAnswer, prompt, promptRef]);
    const [cursorClampedFor, setCursorClampedFor] = useState({ prompt, isLiteralPendingAnswer });
    if (
      cursorClampedFor.prompt !== prompt ||
      cursorClampedFor.isLiteralPendingAnswer !== isLiteralPendingAnswer
    ) {
      setCursorClampedFor({ prompt, isLiteralPendingAnswer });
      if (!isLiteralPendingAnswer) {
        setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
      }
    }

    if (composerSubmissionError !== null) {
      const nextError = getComposerPromptLengthValidationMessage(prompt);
      if (nextError !== composerSubmissionError) {
        setComposerSubmissionError(nextError);
      }
    }

    const providerInputInputs = [
      composerPreviewAnnotations,
      composerReviewComments,
      composerTerminalContexts,
      prompt,
      selectedModel,
      selectedPromptEffort,
      selectedProvider,
    ] as const;
    const [providerInputValidatedFor, setProviderInputValidatedFor] = useState(providerInputInputs);
    if (providerInputInputs.some((value, index) => value !== providerInputValidatedFor[index])) {
      setProviderInputValidatedFor(providerInputInputs);
      setProviderInputSubmissionError(null);
    }

    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the shared images ref in step with committed draft images for async handlers
    useEffect(() => {
      composerImagesRef.current = composerImages;
    }, [composerImages, composerImagesRef]);

    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the shared files ref in step with committed draft files for async handlers
    useEffect(() => {
      composerFilesRef.current = composerFiles;
    }, [composerFiles, composerFilesRef]);

    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the shared terminal contexts ref in step with committed draft contexts for async handlers
    useEffect(() => {
      composerTerminalContextsRef.current = composerTerminalContexts;
    }, [composerTerminalContexts, composerTerminalContextsRef]);

  return { composerSendState, composerTriggerKind, linkedEnvironments, composerMenuItems, isComposerMenuLoading, composerMenuEmptyState, composerMenuOpen, composerMenuSearchKey, activeComposerMenuItemId, activeComposerMenuItem, isComposerApprovalState, followUpBehavior, composerSuggestionsVisible, composerSuggestionListVisible, activePendingUserInput, isChoiceOnlyPendingQuestion, showComposerTopDrawer, showCollapsedMobilePromptRow, showComposerAttachAction, composerFooterHasWideActions, editPromptFromTraitsStable, promptUltrathink, setInlineRestingControlsHost, restingComposerControlsRef, attachRestingComposerControls, restingControlsHiddenBlockCount, restingControlsIconOnlyBlockCount, restingControlsVisible, attachExpandedComposerControls, expandedControlsHiddenBlockCount, expandedControlsIconOnlyBlockCount, pendingPrimaryAction, showResumeAction, collapsedComposerPrimaryActionDisabled, collapsedComposerPrimaryActionLabel, showMobilePendingAnswerActions, setPrompt, addComposerImage, addComposerImagesToDraft, addComposerFilesToDraft, removeComposerImageFromDraft, removeComposerFileFromDraft, addComposerDraftReviewComment, addComposerDraftPreviewAnnotation, addComposerDraftThreadContexts, setComposerDraftThreadContexts, addComposerDraftEnvironmentContexts, setComposerDraftEnvironmentContexts, buildContextClipboardFragment, buildContextClipboardFragmentStable, loadThreadTranscript, countReservedAttachments, countReservedAttachmentsStable, importContextRecords, importContextFragment, importContextFragmentStable };
}
