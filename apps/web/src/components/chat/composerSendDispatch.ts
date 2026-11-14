import { flushSync } from "react-dom";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import { parseCodexFeedbackCommand, submitCodexFeedback } from "@t3tools/client-runtime/state/threads";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import {
  buildExpiredTerminalContextToastCopy,
  deriveComposerSendState,
  formatOutgoingPrompt,
  planComposerTurn,
  restorePlanFollowUpComposer,
  shouldDockDraftHeroForSubmission,
  snapshotComposerSend,
} from "../ChatView.logic";
import { composerDraftHasUserContent, useComposerDraftStore } from "../../composerDraftStore";
import { buildMessageContext } from "../../lib/composerContextRecords";
import { parseStandaloneComposerSlashCommand } from "../../composer-logic";
import { readEnvironmentScope } from "../../state/session";
import { readEnvironmentPresentation } from "./composerSendResolve";
import { resolvePlanFollowUpSubmission } from "../../proposedPlan";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { resolveMultipleModelTargets, type MultipleModelTarget } from "./chatViewSend";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";
import { runMobileComposerTransition } from "./draftHeroTransition";
import { newMessageId } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerSendRuntime } from "./useComposerSendState";
import type { resolveComposerSend } from "./composerSendResolve";

export type ComposerSendPlan = Extract<
  Awaited<ReturnType<typeof resolveComposerSend>>,
  { halted: false }
>;

/**
 * Prepares an accepted send: the turn snapshot and plan, attachment uploads, the draft-hero
 * dock, and the capability checks that can still refuse it. `done` reports that this press
 * is finished (sent elsewhere or refused), otherwise the send carries on to completion.
 */
export async function dispatchComposerSend(rt: ComposerSendRuntime, plan: ComposerSendPlan) {
  const {
    activeMessageCount,
    activeProposedPlan,
    activeThreadBranch,
    activeThreadKey,
    captureDraftHeroComposerRect,
    clearComposerDraftContent,
    composerDraftTarget,
    composerRef,
    composerSendGenerationRef,
    composerTerminalContextsRef,
    currentRouteThreadKeyRef,
    environmentId,
    feedbackUploadsInFlightRef,
    handleInteractionModeChange,
    isDraftHeroState,
    isServerThread,
    keepFullHistory,
    panelAnimationDurationMs,
    panelAnimationsActive,
    handleNewThreadInActiveProject,
    phase,
    planModeEnabled,
    promptRef,
    providerInstanceEntries,
    queuedRunEdit,
    resumeCompactionTokens,
    routeThreadKey,
    sendEnvMode,
    sendInFlightRef,
    sendQueuesBehindSetup,
    setComposerDraftEnvironmentContexts,
    setComposerDraftPrompt,
    setComposerDraftPreviewAnnotations,
    setComposerDraftReviewComments,
    setComposerDraftTerminalContexts,
    setComposerDraftThreadContexts,
    setDockedDraftHeroThreadKey,
    setFeedbackSubmissionsByThreadKey,
    setThreadError,
    showPlanFollowUpPrompt,
    submitPlanFollowUp,
    uploadThreadFeedback,
  } = rt;
  const {
    activeProject,
    activeThread,
    composerEnvironmentContexts,
    composerFiles,
    composerImages,
    directAnnotation,
    dispatchMode,
    submissionIntent,
    composerPreviewAnnotations,
    composerReviewComments,
    composerTerminalContexts,
    composerThreadContexts,
    ctxSelectedModel,
    ctxSelectedProvider,
    ctxSelectedProviderModels,
    ctxSelectedPromptEffort,
    multipleModelSelections,
    promptForSend,
    sendInteractionMode,
    sendInteractionModeEnabled,
  } = plan;
  if (queuedRunEdit.isEditing) {
    // Edit mode repurposes the composer: sending saves the queued message
    // in place instead of dispatching a new turn.
    await queuedRunEdit.saveEdit(
      {
        prompt: promptForSend,
        images: composerImages,
        files: composerFiles,
        terminalContexts: composerTerminalContexts,
        reviewComments: composerReviewComments,
        previewAnnotations: composerPreviewAnnotations,
        threadContexts: composerThreadContexts,
        environmentContexts: composerEnvironmentContexts,
      },
      setThreadError,
    );
    return { done: true as const };
  }
  const {
    trimmedPrompt: trimmed,
    sendableTerminalContexts: sendableComposerTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent,
  } = deriveComposerSendState({
    prompt: promptForSend,
    imageCount: composerImages.length + composerFiles.length,
    terminalContexts: composerTerminalContexts,
    elementContextCount:
      composerPreviewAnnotations.length +
      composerReviewComments.length +
      composerThreadContexts.length +
      composerEnvironmentContexts.length,
  });
  const feedbackCommand =
    ctxSelectedProvider === "codex" &&
    composerImages.length === 0 &&
    composerFiles.length === 0 &&
    sendableComposerTerminalContexts.length === 0 &&
    composerPreviewAnnotations.length === 0 &&
    composerReviewComments.length === 0 &&
    composerThreadContexts.length === 0 &&
    composerEnvironmentContexts.length === 0
      ? parseCodexFeedbackCommand(trimmed)
      : null;
  if (feedbackCommand && multipleModelSelections === null) {
    if (!isServerThread || activeThread.activeProviderThreadId === null) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Start a Codex thread first",
          description: "Send a message before you submit feedback.",
        }),
      );
      return { done: true as const };
    }
    feedbackUploadsInFlightRef.current.add(routeThreadKey);
    await submitCodexFeedback({
      submission: {
        id: newMessageId(),
        command: trimmed,
        createdAt: new Date().toISOString(),
      },
      clearDraft: () => {
        promptRef.current = "";
        clearComposerDraftContent(composerDraftTarget);
        composerRef.current?.resetCursorState();
      },
      onUpdate: (submission) => {
        setFeedbackSubmissionsByThreadKey((current) => {
          const existing = current[routeThreadKey] ?? [];
          const found = existing.some((entry) => entry.id === submission.id);
          return {
            ...current,
            [routeThreadKey]: found
              ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
              : [...existing, submission],
          };
        });
      },
      upload: () =>
        uploadThreadFeedback({
          environmentId: activeThread.environmentId,
          input: { threadId: activeThread.id, ...feedbackCommand },
        }),
    }).finally(() => {
      feedbackUploadsInFlightRef.current.delete(routeThreadKey);
    });

    return { done: true as const };
  }
  if (
    !directAnnotation &&
    sendInteractionModeEnabled &&
    showPlanFollowUpPrompt &&
    activeProposedPlan &&
    composerImages.length === 0 &&
    composerFiles.length === 0
  ) {
    const followUp = resolvePlanFollowUpSubmission({
      draftText: promptForSend,
      planMarkdown: activeProposedPlan.planMarkdown,
    });
    const outgoingFollowUpText = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: followUp.text.trim(),
    });
    if (composerRef.current?.validateProviderInput(outgoingFollowUpText) === false) {
      return { done: true as const };
    }
    const followUpPromptSnapshot = promptRef.current;
    const followUpTerminalContexts = [...sendableComposerTerminalContexts];
    const followUpReviewComments = [...composerReviewComments];
    const followUpPreviewAnnotations = [...composerPreviewAnnotations];
    const followUpThreadContexts = [...composerThreadContexts];
    const followUpEnvironmentContexts = [...composerEnvironmentContexts];
    promptRef.current = "";
    clearComposerDraftContent(composerDraftTarget);
    composerRef.current?.resetCursorState();
    const followUpSent = await submitPlanFollowUp({
      text: followUp.text,
      context: buildMessageContext({
        terminalContexts: sendableComposerTerminalContexts,
        reviewComments: composerReviewComments,
        previewAnnotations: composerPreviewAnnotations,
        threadContexts: composerThreadContexts,
        environmentContexts: composerEnvironmentContexts,
      }),
      interactionMode: followUp.interactionMode,
    });
    if (!followUpSent) {
      restorePlanFollowUpComposer({
        snapshot: {
          prompt: followUpPromptSnapshot,
          terminalContexts: followUpTerminalContexts,
          reviewComments: followUpReviewComments,
          previewAnnotations: followUpPreviewAnnotations,
          threadContexts: followUpThreadContexts,
          environmentContexts: followUpEnvironmentContexts,
        },
        draftHasUserContent: composerDraftHasUserContent(
          useComposerDraftStore.getState().getComposerDraft(composerDraftTarget),
        ),
        routeIsCurrent: currentRouteThreadKeyRef.current === routeThreadKey,
        writeComposerRefs: (snapshot) => {
          promptRef.current = snapshot.prompt;
          composerTerminalContextsRef.current = [...snapshot.terminalContexts];
        },
        writePrompt: (prompt) => setComposerDraftPrompt(composerDraftTarget, prompt),
        writeTerminalContexts: (contexts) =>
          setComposerDraftTerminalContexts(composerDraftTarget, [...contexts]),
        writeReviewComments: (comments) =>
          setComposerDraftReviewComments(composerDraftTarget, [...comments]),
        writePreviewAnnotations: (annotations) =>
          setComposerDraftPreviewAnnotations(composerDraftTarget, [...annotations]),
        writeThreadContexts: (records) =>
          setComposerDraftThreadContexts(composerDraftTarget, [...records]),
        writeEnvironmentContexts: (records) =>
          setComposerDraftEnvironmentContexts(composerDraftTarget, [...records]),
        resetCursor: (options) => composerRef.current?.resetCursorState(options),
      });
    } else if (
      submissionIntent === "background" &&
      currentRouteThreadKeyRef.current === routeThreadKey
    ) {
      handleNewThreadInActiveProject();
    }
    return { done: true as const };
  }
  const standaloneSlashCommand =
    sendInteractionModeEnabled &&
    composerImages.length === 0 &&
    composerFiles.length === 0 &&
    sendableComposerTerminalContexts.length === 0 &&
    composerPreviewAnnotations.length === 0 &&
    composerReviewComments.length === 0 &&
    composerThreadContexts.length === 0 &&
    composerEnvironmentContexts.length === 0
      ? parseStandaloneComposerSlashCommand(trimmed)
      : null;
  if (standaloneSlashCommand && multipleModelSelections === null) {
    handleInteractionModeChange(standaloneSlashCommand);
    promptRef.current = "";
    clearComposerDraftContent(composerDraftTarget);
    composerRef.current?.resetCursorState();
    return { done: true as const };
  }
  if (!hasSendableContent) {
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "empty",
      );
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        }),
      );
    }
    return { done: true as const };
  }
  if (!activeProject) {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Choose a project first",
        description: "This draft no longer points to an available project.",
      }),
    );
    return { done: true as const };
  }
  const threadIdForSend = activeThread.id;
  const sendSnapshot = snapshotComposerSend({
    prompt: promptForSend,
    images: composerImages,
    files: composerFiles,
    terminalContexts: composerTerminalContexts,
    sendableTerminalContexts: sendableComposerTerminalContexts,
    previewAnnotations: composerPreviewAnnotations,
    reviewComments: composerReviewComments,
    threadContexts: composerThreadContexts,
    environmentContexts: composerEnvironmentContexts,
  });
  const {
    files: composerFilesSnapshot,
    attachments: composerAttachmentsSnapshot,
    terminalContexts: composerTerminalContextsSnapshot,
    previewAnnotations: composerPreviewAnnotationsSnapshot,
    reviewComments: composerReviewCommentsSnapshot,
    threadContexts: composerThreadContextsSnapshot,
    environmentContexts: composerEnvironmentContextsSnapshot,
    messageText: messageTextForSend,
  } = sendSnapshot;
  const {
    missingWorktreeBaseBranch,
    baseBranchForWorktree,
    compactBeforeSend,
    turnDispatchMode,
    shouldQueueBehindActiveRun,
  } = planComposerTurn({
    messageText: messageTextForSend,
    sendQueuesBehindSetup,
    isServerThread,
    activeMessageCount,
    sendEnvMode,
    worktreePath: activeThread.worktreePath,
    activeThreadBranch,
    resumeCompactionTokens,
    keepFullHistory,
    phase,
    dispatchMode,
  });
  if (missingWorktreeBaseBranch) {
    setThreadError(threadIdForSend, "Select a base branch before sending in New worktree mode.");
    return { done: true as const };
  }
  // Records bind attachments by the id each side knows: the local id for the optimistic
  // row, the upload id (or local id on the data-URL path) on the wire; the server
  // rebinds them to the persisted id.
  const buildOutgoingMessageContext = (attachmentIds: ReadonlyArray<string>) =>
    buildMessageContext({
      terminalContexts: composerTerminalContextsSnapshot,
      reviewComments: composerReviewCommentsSnapshot,
      previewAnnotations: composerPreviewAnnotationsSnapshot,
      threadContexts: composerThreadContextsSnapshot,
      environmentContexts: composerEnvironmentContextsSnapshot,
      attachments: composerAttachmentsSnapshot.map((attachment, index) => ({
        attachment,
        attachmentId: attachmentIds[index] ?? attachment.id,
      })),
    });
  const outgoingMessageContext = buildOutgoingMessageContext(
    composerAttachmentsSnapshot.map((attachment) => attachment.id),
  );
  const messageIdForSend = newMessageId();
  const messageCreatedAt = new Date().toISOString();
  const outgoingMessageText = formatOutgoingPrompt({
    provider: ctxSelectedProvider,
    model: ctxSelectedModel,
    models: ctxSelectedProviderModels,
    effort: ctxSelectedPromptEffort,
    text: messageTextForSend || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  });
  if (composerRef.current?.validateProviderInput(outgoingMessageText) === false) {
    return { done: true as const };
  }

  const readLiveAttachmentCapabilities = () => {
    const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
    const liveSupportsAttachmentUploads = config !== null;
    return {
      supportsAttachmentUploads: liveSupportsAttachmentUploads,
      fileBlockReason: fileAttachmentCapabilityBlockReason({
        files: composerFilesSnapshot,
        attachmentUploadsCapabilityKnown: config !== null,
        supportsAttachmentUploads: liveSupportsAttachmentUploads,
        maxFileAttachmentBytes:
          config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
      }),
    };
  };

  const multipleTargets: MultipleModelTarget[] = [];
  for (const resolved of resolveMultipleModelTargets({
    selections: multipleModelSelections ?? [],
    providerInstanceEntries,
    messageText: messageTextForSend,
    planModeEnabled,
    interactionMode: sendInteractionMode,
  })) {
    if ("error" in resolved) {
      setThreadError(threadIdForSend, resolved.error);
      return { done: true as const };
    }
    if (composerRef.current?.validateProviderInput(resolved.text) === false) return { done: true as const };
    multipleTargets.push(resolved);
  }

  sendInFlightRef.current = true;
  const sendGeneration = ++composerSendGenerationRef.current;
  const attachmentCapabilitiesBeforeUpload = readLiveAttachmentCapabilities();
  if (attachmentCapabilitiesBeforeUpload.fileBlockReason !== null) {
    sendInFlightRef.current = false;
    setThreadError(threadIdForSend, attachmentCapabilitiesBeforeUpload.fileBlockReason);
    return { done: true as const };
  }
  const turnUsesAttachmentUploads =
    composerFilesSnapshot.length > 0
      ? attachmentCapabilitiesBeforeUpload.supportsAttachmentUploads
      : (readEnvironmentPresentation(environmentId)?.serverConfig ?? null) !== null;
  if (turnUsesAttachmentUploads && composerAttachmentsSnapshot.length > 0) {
    for (const attachment of composerAttachmentsSnapshot) {
      const upload =
        readAttachmentUpload(attachment.id)?.status === "failed"
          ? retryAttachmentUpload
          : startAttachmentUpload;
      upload({
        environmentId,
        image: attachment,
        draftTarget: composerDraftTarget,
      });
    }
    await awaitAttachmentUploads(composerAttachmentsSnapshot.map((attachment) => attachment.id));
    const attachmentCapabilitiesAfterUpload = readLiveAttachmentCapabilities();
    if (attachmentCapabilitiesAfterUpload.fileBlockReason !== null) {
      sendInFlightRef.current = false;
      setThreadError(threadIdForSend, attachmentCapabilitiesAfterUpload.fileBlockReason);
      return { done: true as const };
    }
    if (getUploadedAttachments({ environmentId, images: composerAttachmentsSnapshot }) === null) {
      sendInFlightRef.current = false;
      setThreadError(threadIdForSend, "Retry or remove failed uploads before sending.");
      return { done: true as const };
    }
  }

  if (
    multipleModelSelections === null &&
    shouldDockDraftHeroForSubmission({ isDraftHeroState, activeThreadKey, submissionIntent }) &&
    activeThreadKey
  ) {
    let resolveDockStarted: (() => void) | undefined;
    const dockStarted = new Promise<void>((resolve) => {
      resolveDockStarted = resolve;
    });
    const dockTransition = runMobileComposerTransition(
      () => {
        flushSync(() => {
          captureDraftHeroComposerRect();
          setDockedDraftHeroThreadKey(activeThreadKey);
        });
        resolveDockStarted?.();
      },
      {
        active: panelAnimationsActive,
        durationMs: panelAnimationDurationMs,
      },
    );
    void dockTransition.catch(() => resolveDockStarted?.());
    await dockStarted;
  }

  const attachmentCapabilitiesBeforeDispatch = readLiveAttachmentCapabilities();
  if (
    !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
    attachmentCapabilitiesBeforeDispatch.fileBlockReason !== null
  ) {
    sendInFlightRef.current = false;
    setThreadError(
      threadIdForSend,
      attachmentCapabilitiesBeforeDispatch.fileBlockReason ??
        "This connection cannot change threads.",
    );
    setDockedDraftHeroThreadKey((currentThreadKey) =>
      currentThreadKey === activeThreadKey ? null : currentThreadKey,
    );
    return { done: true as const };
  }

  return {
    done: false as const,
    activeProject,
    baseBranchForWorktree,
    buildOutgoingMessageContext,
    compactBeforeSend,
    composerAttachmentsSnapshot,
    composerEnvironmentContextsSnapshot,
    composerFilesSnapshot,
    composerPreviewAnnotationsSnapshot,
    composerReviewCommentsSnapshot,
    composerTerminalContextsSnapshot,
    composerThreadContextsSnapshot,
    expiredTerminalContextCount,
    messageCreatedAt,
    messageIdForSend,
    messageTextForSend,
    multipleTargets,
    threadIdForSend,
    outgoingMessageContext,
    outgoingMessageText,
    readLiveAttachmentCapabilities,
    sendGeneration,
    sendSnapshot,
    shouldQueueBehindActiveRun,
    turnDispatchMode,
    turnUsesAttachmentUploads,
  };
}
