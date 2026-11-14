import type { ChatComposerProps } from "./chatComposerTypes";

import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  composerFileNeedsReattach,
  composerDraftHasUserContent,
  composerTargetKey,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../../composerDraftStore";import { useComposerTypingGuard } from "./useComposerTypingGuard";
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
  questionAttachmentDraftId,
  trackOpenQuestionAttachmentDraft,
  useQuestionAttachmentPreparation,
} from "../../questionAttachments";
import {
  collectInlineContextIds,
  type ComposerContextReference,
  ensureInlineContextReferences,
  formatInlineContextReference,
  insertInlineContextReference,
  inlineContextReferenceReplacement,
} from "~/lib/composerContextReferences";
import {
  threadContextRecord,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import {
  attachmentsToReleaseOnUploadCapabilityLoss,
  composerOtherFilesForPresentation,
  fileAttachmentCapabilityBlockReason,
  fileAttachmentStagingLimit,
  isPreviewableComposerVideo,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";
import { useComposerImageGroups } from "./useComposerImageGroups";
import {
  countPreparingComposerImages,
  usePreparingComposerImages,
} from "./preparingComposerImages";
import {
  releaseAttachmentUpload,
  releaseDraftAttachment,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import {
  buildAttachmentVideoPreview,
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { useRightPanelStore } from "~/rightPanelStore";
import { isVideoAttachment, type SessionPhase, type Thread, type ThreadShell } from "../../types";
import {
  ComposerContextActionsContext,
  composerContextRecordsFromDraft,
} from "../composerContextPresentation";
import { attachmentUploadBlockReason } from "../../lib/attachmentUploadState";
export function useComposerDraftAttachments(props: ChatComposerProps) {
  const { contextWindowEntries, contextWindowLiveUsage, contextWindowProviderThread, composerDraftTarget, pendingApprovals, pendingUserInputs: incomingPendingUserInputs, onHeldRequestIdsChange, activePendingApproval: incomingPendingApproval, activePendingProgress: incomingPendingProgress, activePendingIsResponding: incomingPendingIsResponding, editingQueuedAttachments, environmentId, activeThreadId, supportsQuestionAttachments, routeThreadRef, gitCwd, onExpandImage, attachmentUploadsCapabilityKnown, supportsAttachmentUploads, maxFileAttachmentBytes, canOperateThread } = props;
    const activeContextWindow = deriveLatestContextWindowSnapshot(
      contextWindowEntries,
      contextWindowLiveUsage,
      contextWindowProviderThread,
    );
    const primaryEnvironmentId = usePrimaryEnvironmentId();
    const composerDraftTargetKey = composerTargetKey(composerDraftTarget);
    const {
      heldRequestIds,
      onDraftChange: onTypingGuardDraftChange,
      onFocus: onTypingGuardFocus,
      onBlur: onTypingGuardBlur,
      onSend: onTypingGuardSend,
    } = useComposerTypingGuard(composerDraftTargetKey, [
      ...pendingApprovals.map((request) => request.requestId),
      ...incomingPendingUserInputs.map((request) => request.requestId),
    ]);
    // A layout effect so the timeline never paints a held approval as answerable.
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes held requests to the timeline without lifting per-keystroke typing state
    useLayoutEffect(() => {
      onHeldRequestIdsChange(heldRequestIds);
    }, [heldRequestIds, onHeldRequestIdsChange]);
    const activePendingApproval =
      incomingPendingApproval && !heldRequestIds.has(incomingPendingApproval.requestId)
        ? incomingPendingApproval
        : null;
    const holdingUserInput = incomingPendingUserInputs[0]
      ? heldRequestIds.has(incomingPendingUserInputs[0].requestId)
      : false;
    const pendingUserInputs = holdingUserInput ? [] : incomingPendingUserInputs;
    const activePendingProgress = holdingUserInput ? null : incomingPendingProgress;
    const activePendingIsResponding = !holdingUserInput && incomingPendingIsResponding;
    const isLiteralPendingAnswer = activePendingProgress?.activeQuestion?.initialAnswer !== undefined;
    const isEditingQueuedMessage = editingQueuedAttachments !== null;
    const composerDraft = useComposerThreadDraft(composerDraftTarget);
    const composerDraftTargetKeyRef = useRef("");
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed draft target key to a ref read by async handlers
    useLayoutEffect(() => {
      composerDraftTargetKeyRef.current = composerDraftTargetKey;
    });
    const questionAttachmentTarget =
      pendingUserInputs[0] && activePendingProgress?.activeQuestion
        ? questionAttachmentDraftId(
            environmentId,
            activeThreadId!,
            pendingUserInputs[0].requestId,
            activePendingProgress.activeQuestion.id,
          )
        : null;
    const attachmentDraftTarget = questionAttachmentTarget ?? composerDraftTarget;
    const attachmentDraft = useComposerThreadDraft(attachmentDraftTarget);
    const questionTakesSnapShots =
      supportsQuestionAttachments &&
      activePendingProgress?.activeQuestion?.allowCustomAnswer !== false &&
      !activePendingIsResponding;
    const questionRequest = pendingUserInputs[0];
    // Publish eligibility before async captures can observe a question the UI has already closed.
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the open question's attachment draft in the module tracker before async captures read it
    useLayoutEffect(() => {
      if (!questionAttachmentTarget || !questionRequest || !questionTakesSnapShots) return;
      return trackOpenQuestionAttachmentDraft(routeThreadRef, {
        draftId: questionAttachmentTarget,
        requestKeys: questionRequest.questions.map((question) =>
          questionAttachmentDraftId(
            environmentId,
            activeThreadId!,
            questionRequest.requestId,
            question.id,
          ),
        ),
      });
    }, [
      activeThreadId,
      environmentId,
      questionAttachmentTarget,
      questionRequest,
      questionTakesSnapShots,
      routeThreadRef,
    ]);
    const attachmentTargetKey = composerTargetKey(attachmentDraftTarget);
    // Reject async imports after a draft switch.
    const attachmentTargetKeyRef = useRef(attachmentTargetKey);
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed attachment target key to a ref so async imports reject after a draft switch
    useLayoutEffect(() => {
      attachmentTargetKeyRef.current = attachmentTargetKey;
    });
    const questionPreparations = useQuestionAttachmentPreparation((state) => state.counts);
    const prompt = composerDraft.prompt;
    const composerImages = attachmentDraft.images;
    const composerFiles = attachmentDraft.files;
    const inlineFileIdSet = (() => {
      if (questionAttachmentTarget) return new Set<string>();
      const contextIds = new Set(collectInlineContextIds(prompt));
      return new Set(
        composerFiles
          .filter((file) => contextIds.has(toKindScopedComposerContextId("file", file.id)))
          .map((file) => file.id),
      );
    })();
    const composerVideos = composerFiles.filter((file) =>
      isPreviewableComposerVideo(file, environmentId),
    );
    const composerOtherFiles = composerOtherFilesForPresentation(
      composerFiles,
      environmentId,
      inlineFileIdSet,
    );
    const composerTerminalContexts = composerDraft.terminalContexts;
    const composerPreviewAnnotations = composerDraft.previewAnnotations;
    const composerReviewComments = composerDraft.reviewComments;
    const composerThreadContexts = attachmentDraft.threadContexts;
    const composerEnvironmentContexts = composerDraft.environmentContexts;
    const {
      pendingSnapShotAnimations,
      pendingSnapShotIds,
      uncommittedSnapShotIds,
      standaloneComposerImages,
    } = useComposerImageGroups(attachmentDraftTarget, composerImages, composerPreviewAnnotations);
    const preparingComposerImages = usePreparingComposerImages(attachmentTargetKey);
    const nonPersistedComposerImageIds = attachmentDraft.nonPersistedImageIds;
    const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);
    const openPrLink = useOpenPrLink(routeThreadRef);
    const [previewFileId, setPreviewFileId] = useState<string | null>(null);
    const previewFile = composerFiles.find((file) => file.id === previewFileId);
    const composerContextActions = {
      environmentId,
      cwd: gitCwd ?? undefined,
      expandImage: (imageId: string) => {
        const preview = buildExpandedImagePreview(composerImages, imageId);
        if (preview) onExpandImage(preview);
      },
      openFile: setPreviewFileId,
      openMention: (path: string) => useRightPanelStore.getState().openFile(routeThreadRef, path),
      expandVideo: (fileId: string) => {
        const file = composerFiles.find((candidate) => candidate.id === fileId);
        if (!file || !isVideoAttachment(file)) return;
        const localPreview = buildExpandedImagePreview([file], file.id);
        if (localPreview) {
          onExpandImage(localPreview);
          return;
        }
        if (file.uploadedAttachmentId === undefined || file.uploadEnvironmentId !== environmentId) {
          return;
        }
        const persistedPreview = buildAttachmentVideoPreview(environmentId, {
          type: "file",
          id: file.uploadedAttachmentId,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        });
        if (persistedPreview) onExpandImage(persistedPreview);
      },
      openPullRequest: (event: React.MouseEvent<HTMLElement>, url: string) => {
        openPrLink(event, url);
      },
    };
    const composerContextRecords = composerContextRecordsFromDraft({
      terminalContexts: composerTerminalContexts,
      reviewComments: composerReviewComments,
      previewAnnotations: composerPreviewAnnotations,
      threadContexts: composerThreadContexts,
      environmentContexts: composerEnvironmentContexts,
      images: composerImages,
      files: composerFiles,
      uploadsByImageId,
    });
    const needsReattachFileCount = composerFiles.filter(composerFileNeedsReattach).length;
    const fileStagingLimit = fileAttachmentStagingLimit({
      attachmentUploadsCapabilityKnown,
      supportsAttachmentUploads,
      maxFileAttachmentBytes,
    });
    const fileCapabilityBlockReason = fileAttachmentCapabilityBlockReason({
      files: composerFiles,
      attachmentUploadsCapabilityKnown,
      supportsAttachmentUploads,
      maxFileAttachmentBytes,
    });
    const attachmentBlockReason =
      (questionAttachmentTarget &&
      !supportsQuestionAttachments &&
      (composerImages.length > 0 || composerFiles.length > 0)
        ? "Update this server to send files with question answers"
        : null) ??
      fileCapabilityBlockReason ??
      (supportsAttachmentUploads
        ? needsReattachFileCount > 0
          ? needsReattachFileCount === 1
            ? "Attach the interrupted file again or remove it"
            : "Attach the interrupted files again or remove them"
          : attachmentUploadBlockReason({
              imageIds: [...composerImages, ...composerFiles].map((attachment) => attachment.id),
              uploadsByImageId,
              environmentId,
            })
        : null);
    const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
    const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
    const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
    const addComposerDraftFiles = useComposerDraftStore((store) => store.addFiles);
    const removeComposerDraftFile = useComposerDraftStore((store) => store.removeFile);
    const insertComposerDraftTerminalContext = useComposerDraftStore(
      (store) => store.insertTerminalContext,
    );
    const setComposerDraftTerminalContexts = useComposerDraftStore(
      (store) => store.setTerminalContexts,
    );
    const removeComposerDraftPreviewAnnotation = useComposerDraftStore(
      (store) => store.removePreviewAnnotation,
    );
    const removeComposerDraftReviewComment = useComposerDraftStore(
      (store) => store.removeReviewComment,
    );
    const clearComposerDraftPersistedAttachments = useComposerDraftStore(
      (store) => store.clearPersistedAttachments,
    );
    const syncComposerDraftPersistedAttachments = useComposerDraftStore(
      (store) => store.syncPersistedAttachments,
    );
    const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);

    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts or releases server attachment uploads as upload capability, limits and draft attachments change
    useEffect(() => {
      if (!attachmentUploadsCapabilityKnown) {
        return;
      }
      if (!supportsAttachmentUploads) {
        // Reconnect or version skew can hide upload support; retain hydrated uploads.
        for (const attachment of attachmentsToReleaseOnUploadCapabilityLoss([
          ...composerImages,
          ...composerFiles,
        ])) {
          releaseAttachmentUpload(attachment.id);
        }
        return;
      }
      if (!canOperateThread) return;
      const invalidFiles =
        maxFileAttachmentBytes === null
          ? composerFiles
          : composerFiles.filter((file) => file.sizeBytes > maxFileAttachmentBytes);
      for (const attachment of attachmentsToReleaseOnUploadCapabilityLoss(invalidFiles)) {
        releaseAttachmentUpload(attachment.id);
      }
      const uploadableFiles =
        maxFileAttachmentBytes === null
          ? []
          : composerFiles.filter((file) => file.sizeBytes <= maxFileAttachmentBytes);
      const uploadableAttachments = [...composerImages, ...uploadableFiles];
      for (const attachment of uploadableAttachments) {
        if (attachment.type === "file" && composerFileNeedsReattach(attachment)) {
          continue;
        }
        startAttachmentUpload({
          environmentId,
          image: attachment,
          draftTarget: attachmentDraftTarget,
        });
      }
    }, [
      attachmentUploadsCapabilityKnown,
      attachmentDraftTarget,
      canOperateThread,
      composerFiles,
      composerImages,
      environmentId,
      maxFileAttachmentBytes,
      supportsAttachmentUploads,
    ]);

  return { activeContextWindow, primaryEnvironmentId, composerDraftTargetKey, heldRequestIds, onTypingGuardDraftChange, onTypingGuardFocus, onTypingGuardBlur, onTypingGuardSend, activePendingApproval, pendingUserInputs, activePendingProgress, activePendingIsResponding, isLiteralPendingAnswer, isEditingQueuedMessage, composerDraft, composerDraftTargetKeyRef, questionAttachmentTarget, attachmentDraftTarget, attachmentTargetKey, attachmentTargetKeyRef, questionPreparations, prompt, composerImages, composerFiles, composerVideos, composerOtherFiles, composerTerminalContexts, composerPreviewAnnotations, composerReviewComments, composerThreadContexts, composerEnvironmentContexts, pendingSnapShotAnimations, pendingSnapShotIds, uncommittedSnapShotIds, standaloneComposerImages, preparingComposerImages, nonPersistedComposerImageIds, uploadsByImageId, setPreviewFileId, previewFile, composerContextActions, composerContextRecords, fileStagingLimit, attachmentBlockReason, setComposerDraftPrompt, addComposerDraftImages, removeComposerDraftImage, addComposerDraftFiles, removeComposerDraftFile, insertComposerDraftTerminalContext, setComposerDraftTerminalContexts, removeComposerDraftPreviewAnnotation, removeComposerDraftReviewComment, clearComposerDraftPersistedAttachments, syncComposerDraftPersistedAttachments, getComposerDraft };
}
