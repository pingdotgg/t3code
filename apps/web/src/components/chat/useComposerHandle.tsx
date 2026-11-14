import type { ChatComposerProps } from "./chatComposerTypes";
import { useComposerDraftAttachments } from "./useComposerDraftAttachments";
import { useComposerProviderModelState } from "./useComposerProviderModelState";
import { useComposerCommandState } from "./useComposerCommandState";
import { useComposerPromptEditing } from "./useComposerPromptEditing";
import { useComposerSubmissionState } from "./useComposerSubmissionState";
import { useComposerSurfaceLayout } from "./useComposerSurfaceLayout";
import { useComposerInputHandlers } from "./useComposerInputHandlers";

import { useStableCallback } from "../../hooks/useStableCallback";
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
  countPreparingComposerImages,
  usePreparingComposerImages,
} from "./preparingComposerImages";
import { pendingDraftWork } from "./pendingDraftWork";
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
import { getComposerPromptInjectionState, getComposerReasoningStep } from "./composerProviderState";
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
import { flushSync } from "react-dom";
import {
  isInsideCollapsedComposerControls,
  isInsideRestingComposerControlScope,
  markOpenToEffort,
  markOpenToPermissions,
} from "./composerEventScope";
import {
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../../lib/terminalContext";
import { cn, isMacPlatform, randomUUID } from "~/lib/utils";
import {
  collectInlineContextIds,
  type ComposerContextReference,
  ensureInlineContextReferences,
  formatInlineContextReference,
  insertInlineContextReference,
  inlineContextReferenceReplacement,
} from "~/lib/composerContextReferences";
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
  getComposerPromptLengthValidationMessage,
  getComposerSubmissionValidationMessage,
  submitComposerDraft,
} from "./composerSubmission";
import {
  ComposerAttachButton,
  ComposerAttachmentFileList,
  ComposerAttachmentMediaRow,
  ComposerFilePreviewDialog,
  ComposerQueuedAttachmentRow,
  ComposerRestingImagePreviews,
} from "./ComposerAttachmentStrip";


function consumePasteAsTextShortcut(deadline: { current: number }): boolean {
  const armed = Date.now() <= deadline.current;
  deadline.current = 0;
  return armed;
}

export function useComposerHandle(props: ChatComposerProps, params: {
  s1: ReturnType<typeof useComposerDraftAttachments>,
  s2: ReturnType<typeof useComposerProviderModelState>,
  s3: ReturnType<typeof useComposerCommandState>,
  s5: ReturnType<typeof useComposerPromptEditing>,
  s6: ReturnType<typeof useComposerSubmissionState>,
  s7: ReturnType<typeof useComposerSurfaceLayout>,
  s8: ReturnType<typeof useComposerInputHandlers>,
  }) {
  const { s1, s2, s3, s5, s6, s7, s8 } = params;
  const { composerRef, focusComposer, promptRef, reportedModelSelection, settings, composerDraftTarget, activeThread, pendingApprovals, composerImagesRef, composerFilesRef, composerTerminalContextsRef, multipleModelSelections, routeKind, onMultipleModelSelectionsChange: setMultipleModelSelections, environmentId, projectSelectionRequired, supportsAttachmentUploads, maxFileAttachmentBytes, canOperateThread, onExpandImage, onFileOpen, resolvedTheme } = props;
  const { composerControlsHidden } = s7;
  const { composerBlurFrameRef, setIsComposerFocused, setIsComposerModelPickerOpen, composerEditorRef, pasteAsTextShortcutUntilRef, noProviderAvailable, selectedProvider, selectedInstanceId, selectedModel, selectedProviderModels, composerModelOptions, isComposerModelPickerOpen, composerFormRef, setComposerHighlightedItemId, setComposerCursor, resetComposerTrigger, setComposerTrigger, selectedPromptEffort, selectedModelSelection, providerSendBlockReason, interactionMode, planModeUiEnabled, providerInputRejectedRef, setProviderInputSubmissionError, composerCursor, isComposerCollapsedMobile } = s2;
  const { addComposerAttachments, addComposerFoldersStable, insertComposerTextAtEndStable, foldPastedText, insertComposerTextStable, removeComposerImage } = s8;
  const { attachmentTargetKey, pendingUserInputs, isEditingQueuedMessage, prompt, isLiteralPendingAnswer, insertComposerDraftTerminalContext, composerTerminalContexts, activePendingProgress, heldRequestIds, composerPreviewAnnotations, composerReviewComments, composerThreadContexts, composerEnvironmentContexts, primaryEnvironmentId, uncommittedSnapShotIds, composerVideos, standaloneComposerImages, preparingComposerImages, composerImages, pendingSnapShotAnimations, pendingSnapShotIds, nonPersistedComposerImageIds, attachmentDraftTarget, composerOtherFiles, fileStagingLimit, setPreviewFileId } = s1;
  const { readComposerSnapshotStable, applyPromptReplacementStable } = s5;
  const { compactThreadContextStable } = s6;
  const { isChoiceOnlyPendingQuestion, removeComposerFileFromDraft, showComposerAttachAction } = s3;
    const openModelPicker = () => {
      if (composerControlsHidden) {
        if (composerBlurFrameRef.current !== null) {
          window.cancelAnimationFrame(composerBlurFrameRef.current);
          composerBlurFrameRef.current = null;
        }
        setIsComposerFocused(true);
      }
      setIsComposerModelPickerOpen(true);
    };
    const openModelPickerStable = useStableCallback(openModelPicker);

    useImperativeHandle(
      composerRef,
      () => ({
        focusAtEnd: () => {
          composerEditorRef.current?.focusAtEnd();
        },
        focusAt: (cursor: number) => {
          composerEditorRef.current?.focusAt(cursor);
        },
        addDroppedFiles: (files: File[]) => {
          void addComposerAttachments(files).then((inserted) => {
            if (!inserted) focusComposer();
          });
        },
        addDroppedFolders: addComposerFoldersStable,
        hasPendingAttachments: () =>
          countPreparingComposerImages(attachmentTargetKey) > 0 ||
          pendingDraftWork.has(attachmentTargetKey),
        insertTextAtEnd: insertComposerTextAtEndStable,
        pasteTextAtEnd: (text: string, options) => {
          const shortcutArmed = consumePasteAsTextShortcut(pasteAsTextShortcutUntilRef);
          const bypassAutoAttachment = options?.bypassAutoAttachment === true || shortcutArmed;
          const promptLength = promptRef.current.length;
          if (
            !foldPastedText(text, bypassAutoAttachment, {
              start: promptLength,
              end: promptLength,
            })
          ) {
            return false;
          }
          focusComposer();
          return true;
        },
        citeAssistantText: (citation, sourceAnchor) =>
          insertComposerTextStable(
            formatAssistantCitationForComposer(citation, citation.comment),
            "cursor",
            { ensureLeadingBoundary: true, citationCommentAnchor: sourceAnchor },
          ),
        openModelPicker: openModelPickerStable,
        stepReasoningEffort: (direction) => {
          if (noProviderAvailable || pendingUserInputs.length > 0 || isEditingQueuedMessage) {
            return;
          }
          const change = getComposerReasoningStep({
            provider: selectedProvider,
            instanceId: selectedInstanceId,
            model: selectedModel,
            models: selectedProviderModels,
            modelOptions: composerModelOptions?.[selectedInstanceId],
            reportedModelSelection,
            prompt: promptRef.current,
            cursor: readComposerSnapshotStable().expandedCursor,
            planModeEnabled: settings.planModeEnabled,
            direction,
          });
          if (!change) return;
          useComposerDraftStore
            .getState()
            .setProviderModelOptions(composerDraftTarget, selectedProvider, change.modelOptions, {
              instanceId: selectedInstanceId,
              model: selectedModel,
              persistSticky: true,
            });
          if (change.prompt !== promptRef.current) {
            applyPromptReplacementStable(0, promptRef.current.length, change.prompt, {
              expandedCursorAfterReplace: change.cursor,
            });
          }
        },
        toggleModelPicker: () => {
          if (isComposerModelPickerOpen) {
            setIsComposerModelPickerOpen(false);
          } else {
            openModelPickerStable();
          }
        },
        openControl: (command) => {
          if (composerBlurFrameRef.current !== null) {
            window.cancelAnimationFrame(composerBlurFrameRef.current);
            composerBlurFrameRef.current = null;
          }
          flushSync(() => setIsComposerFocused(true));
          const shell = composerFormRef.current?.closest('[data-slot="composer-shell"]');
          const trigger = Array.from(
            shell?.querySelectorAll<HTMLButtonElement>(
              `button[data-composer-shortcut~="${command}"]:not(:disabled)`,
            ) ?? [],
          ).find(
            (element) =>
              !element.closest("[inert]") && element.checkVisibility({ visibilityProperty: true }),
          );
          if (!trigger) return;
          trigger.focus({ preventScroll: true });
          if (command === "composer.mode") markOpenToPermissions(trigger);
          if (command === "composer.effort") markOpenToEffort(trigger);
          trigger.click();
        },
        compactContext: compactThreadContextStable,
        isModelPickerOpen: () => isComposerModelPickerOpen,
        isCaretAtStart: () => {
          const range = composerEditorRef.current?.readSelectionRange();
          return range !== undefined && range.start === 0 && range.end === 0;
        },
        readSnapshot: () => {
          return readComposerSnapshotStable();
        },
        resetCursorState: (options?: {
          cursor?: number;
          prompt?: string;
          detectTrigger?: boolean;
        }) => {
          const promptForState = options?.prompt ?? promptRef.current;
          const cursor = clampCollapsedComposerCursor(
            promptForState,
            options?.cursor ?? 0,
            isLiteralPendingAnswer,
          );
          setComposerHighlightedItemId(null);
          setComposerCursor(cursor);
          resetComposerTrigger(
            options?.detectTrigger && !isLiteralPendingAnswer
              ? detectComposerTrigger(
                  promptForState,
                  expandCollapsedComposerCursor(promptForState, cursor),
                )
              : null,
          );
        },
        addTerminalContext: (selection: TerminalContextSelection) => {
          if (!activeThread || isChoiceOnlyPendingQuestion || isLiteralPendingAnswer) return;
          const snapshot = readComposerSnapshotStable();
          const context = {
            id: randomUUID(),
            threadId: activeThread.id,
            createdAt: new Date().toISOString(),
            ...selection,
          };
          const insertion = insertInlineContextReference(
            snapshot.value,
            snapshot.expandedCursor,
            terminalContextReference(context),
          );
          const nextCollapsedCursor = collapseExpandedComposerCursor(
            insertion.prompt,
            insertion.cursor,
          );
          const inserted = insertComposerDraftTerminalContext(
            composerDraftTarget,
            insertion.prompt,
            context,
            composerTerminalContexts.length,
          );
          if (!inserted) return;
          promptRef.current = insertion.prompt;
          setComposerCursor(nextCollapsedCursor);
          setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
          window.requestAnimationFrame(() => {
            composerEditorRef.current?.focusAt(nextCollapsedCursor);
          });
        },
        getSendContext: () => ({
          answeringPendingUserInput: activePendingProgress !== null,
          shownPendingApprovalIds: pendingApprovals
            .map((approval) => approval.requestId)
            .filter((requestId) => !heldRequestIds.has(requestId)),
          prompt: promptRef.current,
          images: composerImagesRef.current,
          files: composerFilesRef.current,
          terminalContexts: composerTerminalContextsRef.current,
          previewAnnotations: composerPreviewAnnotations,
          reviewComments: composerReviewComments,
          threadContexts: composerThreadContexts,
          environmentContexts: composerEnvironmentContexts,
          selectedPromptEffort,
          selectedModelSelection,
          multipleModelSelections:
            routeKind === "draft" && multipleModelSelections !== null
              ? multipleModelSelections.map((selection) =>
                  selection.instanceId === selectedModelSelection.instanceId &&
                  selection.model === selectedModelSelection.model
                    ? selectedModelSelection
                    : selection,
                )
              : null,
          providerAvailable:
            multipleModelSelections !== null ||
            (!noProviderAvailable && providerSendBlockReason === null),
          selectedProvider,
          selectedModel,
          selectedProviderModels,
          interactionMode,
          interactionModeEnabled: planModeUiEnabled,
        }),
        setMultipleModelSelections,
        validateProviderInput: (providerInput: string) => {
          const validationMessage = getComposerSubmissionValidationMessage({
            prompt: promptRef.current,
            providerInput,
            submissionTarget: "provider-turn",
          });
          providerInputRejectedRef.current = validationMessage !== null;
          setProviderInputSubmissionError(validationMessage);
          return validationMessage === null;
        },
      }),
      [
        activeThread,
        addComposerAttachments,
        addComposerFoldersStable,
        foldPastedText,
        composerDraftTarget,
        composerModelOptions,
        isEditingQueuedMessage,
        composerCursor,
        activePendingProgress,
        pendingApprovals,
        heldRequestIds,
        composerTerminalContexts,
        insertComposerDraftTerminalContext,
        insertComposerTextStable,
        insertComposerTextAtEndStable,
        promptRef,
        composerImagesRef,
        composerFilesRef,
        composerTerminalContextsRef,
        composerPreviewAnnotations,
        composerReviewComments,
        composerThreadContexts,
        composerEnvironmentContexts,
        focusComposer,
        environmentId,
        primaryEnvironmentId,
        isChoiceOnlyPendingQuestion,
        isLiteralPendingAnswer,
        pendingUserInputs.length,
        projectSelectionRequired,
        applyPromptReplacementStable,
        isComposerModelPickerOpen,
        openModelPickerStable,
        readComposerSnapshotStable,
        resetComposerTrigger,
        setComposerTrigger,
        selectedModel,
        selectedInstanceId,
        reportedModelSelection,
        settings.planModeEnabled,
        selectedModelSelection,
        multipleModelSelections,
        setMultipleModelSelections,
        routeKind,
        noProviderAvailable,
        providerSendBlockReason,
        selectedPromptEffort,
        selectedProvider,
        selectedProviderModels,
        interactionMode,
        planModeUiEnabled,
        compactThreadContextStable,
      ],
    );

    // Built outside the form's JSX so typing, which rebuilds that JSX, leaves them cached.
    const composerAttachmentMediaRow =
      !isComposerCollapsedMobile &&
      (uncommittedSnapShotIds.length > 0 ||
        composerVideos.length > 0 ||
        standaloneComposerImages.length > 0 ||
        preparingComposerImages.length > 0) ? (
        <ComposerAttachmentMediaRow
          images={composerImages}
          expandedImages={standaloneComposerImages}
          preparingImages={preparingComposerImages}
          videos={composerVideos}
          pendingSnapShotAnimations={pendingSnapShotAnimations}
          pendingSnapShotIds={pendingSnapShotIds}
          uncommittedSnapShotIds={uncommittedSnapShotIds}
          nonPersistedImageIds={nonPersistedComposerImageIds}
          snapShotAnimations={settings.snapShotAnimations}
          supportsAttachmentUploads={supportsAttachmentUploads}
          maxFileAttachmentBytes={maxFileAttachmentBytes}
          environmentId={environmentId}
          attachmentDraftTarget={attachmentDraftTarget}
          canOperateThread={canOperateThread}
          onExpandImage={onExpandImage}
          onFileOpen={onFileOpen}
          onRemoveImage={removeComposerImage}
          onRemoveFile={removeComposerFileFromDraft}
        />
      ) : null;
    const composerAttachmentFileList =
      !isComposerCollapsedMobile && composerOtherFiles.length > 0 ? (
        <ComposerAttachmentFileList
          files={composerOtherFiles}
          resolvedTheme={resolvedTheme}
          supportsAttachmentUploads={supportsAttachmentUploads}
          maxFileAttachmentBytes={maxFileAttachmentBytes}
          fileStagingLimit={fileStagingLimit}
          environmentId={environmentId}
          attachmentDraftTarget={attachmentDraftTarget}
          canOperateThread={canOperateThread}
          onPreviewFile={setPreviewFileId}
          onRemoveFile={removeComposerFileFromDraft}
        />
      ) : null;
    const composerAttachButton = showComposerAttachAction ? (
      <ComposerAttachButton
        addComposerAttachments={addComposerAttachments}
        focusComposer={focusComposer}
      />
    ) : null;

  return { composerAttachmentMediaRow, composerAttachmentFileList, composerAttachButton };
}
