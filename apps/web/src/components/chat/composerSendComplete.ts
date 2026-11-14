import { DEFAULT_MODEL } from "@t3tools/contracts";
import { wasBootstrapThreadDeleted } from "@t3tools/client-runtime/errors";
import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { declinePendingApprovals, sendApprovalFeedback } from "@t3tools/client-runtime/state/thread-requests";
import { createModelSelection } from "@t3tools/shared/model";
import {
  beginBackgroundDraftSubmissionByRef,
  clearBackgroundDraftSubmissionByRef,
  composerDraftHasUserContent,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  restoreFailedDraftThread,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { releaseDraftAttachments } from "../../lib/attachmentUploadQueue";
import { collapseExpandedComposerCursor } from "../../composer-logic";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { ChatMessage } from "../../types";
import {
  boundAttachmentIds,
  buildExpiredTerminalContextToastCopy,
  optimisticMessageAttachments,
  resolveBackgroundDraftWorkspaceOptions,
  withMessageContext,
  sendTitleFallbackLabels,
} from "../ChatView.logic";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { prepareTurnAttachments, restoreComposerDraft } from "./chatViewSend";
import { recordPromptSent } from "../GitHubStarPrompt";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { newMessageId, newThreadId } from "~/lib/utils";
import { approvalRedirectNotice } from "./composerSend.logic";
import type { ComposerSendRuntime } from "./useComposerSendState";
import type { ComposerSendPlan, dispatchComposerSend } from "./composerSendDispatch";

export type ComposerSendHandoff = Extract<
  Awaited<ReturnType<typeof dispatchComposerSend>>,
  { done: false }
>;

/**
 * Finishes an accepted send: declines the approvals it redirects, starts the turn (or the
 * multiple-model fan-out), and rolls the draft back when anything fails.
 */
export async function completeComposerSend(
  rt: ComposerSendRuntime,
  plan: ComposerSendPlan,
  handoff: ComposerSendHandoff,
) {
  const {
    acknowledgeActiveThreadWoke,
    activeProjectDefaultModelSelection,
    activeThreadBranch,
    activeThreadKey,
    anchorNewTurn,
    beginLocalDispatch,
    beginWorktreeSetup,
    clearComposerDraftContent,
    clearUsageLimitsFor,
    composerDraftTarget,
    composerFilesRef,
    composerImagesRef,
    composerRef,
    composerSendGenerationRef,
    composerTerminalContextsRef,
    currentRouteThreadKeyRef,
    draftId,
    draftThread,
    environmentId,
    handleNewThread,
    handleNewThreadInActiveProject,
    isLocalDraftThread,
    isServerThread,
    localCheckoutBranchMismatch,
    navigate,
    onRespondToApproval: onRespondToApprovalStable,
    optimisticBlobPreviews,
    pendingApprovalsRef,
    persistThreadSettingsForNextTurn,
    phase,
    promptRef,
    resetLocalDispatch,
    respondingRequestIdsRef,
    routeThreadKey,
    runtimeMode,
    sendEnvMode,
    sendQueuesBehindSetup,
    sendToMultipleModels,
    setDockedDraftHeroThreadKey,
    setKeepFullHistory,
    setOptimisticUserMessages,
    sendInFlightRef,
    setSetupQueueSendThreadKey,
    setThreadError,
    startFromOrigin,
    startThreadTurn,
  } = rt;
  const {
    activeThread,
    approvalFeedbackTarget,
    ctxSelectedModel,
    ctxSelectedModelSelection,
    directAnnotation,
    dispatchMode,
    multipleModelSelections,
    promptAtSend,
    promptForSend,
    sendCtx,
    sendInteractionMode,
    submissionIntent,
  } = plan;
  const {
    activeProject,
    baseBranchForWorktree,
    buildOutgoingMessageContext,
    compactBeforeSend,
    composerAttachmentsSnapshot,
    composerFilesSnapshot,
    composerTerminalContextsSnapshot,
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
  } = handoff;
  // A message sent while approvals are pending redirects the agent. They are declined only
  // here, after everything above has accepted the send, so local commands and rejected
  // drafts leave them alone. After navigating away during an upload, the shown approvals
  // are another thread's, so this send leaves them alone too.
  const approvalsToDecline =
    currentRouteThreadKeyRef.current === routeThreadKey
      ? pendingApprovalsRef.current.filter((approval) =>
          sendCtx?.shownPendingApprovalIds.includes(approval.requestId),
        )
      : [];
  if (approvalsToDecline.length > 0 || approvalFeedbackTarget !== undefined) {
    // A draft edited since send, or a paste still landing in it, is no longer the message
    // the user sent.
    const attachmentIdsAtSend = composerAttachmentsSnapshot.map((attachment) => attachment.id);
    // A direct annotation send writes its image and reference into the draft as it sends,
    // so the live draft may still lack them; anything else differing is a real edit.
    const annotationImageId = directAnnotation?.image?.id;
    const attachmentIdsBeforeAnnotation = attachmentIdsAtSend.filter(
      (id) => id !== annotationImageId,
    );
    const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
      left.length === right.length && left.every((id, index) => id === right[index]);
    const draftChangedSinceSend = () => {
      if (composerRef.current?.hasPendingAttachments() === true) return true;
      const sendContext = composerRef.current?.getSendContext();
      const attachmentIds = sendContext
        ? [...sendContext.images, ...sendContext.files].map((attachment) => attachment.id)
        : attachmentIdsAtSend;
      const promptUnchanged =
        promptRef.current === promptAtSend || promptRef.current === promptForSend;
      const attachmentsUnchanged =
        sameIds(attachmentIds, attachmentIdsAtSend) ||
        (annotationImageId !== undefined &&
          sameIds(attachmentIds, attachmentIdsBeforeAnnotation));
      return !promptUnchanged || !attachmentsUnchanged;
    };
    const draftBeforeDecline = useComposerDraftStore
      .getState()
      .getComposerDraft(composerDraftTarget);
    const changedBeforeDecline = draftChangedSinceSend();
    const pendingIdsBeforeDecline = pendingApprovalsRef.current.map(
      (approval) => approval.requestId,
    );
    const approvalResponding = approvalsToDecline.some((approval) =>
      respondingRequestIdsRef.current.includes(approval.requestId),
    );
    if (approvalFeedbackTarget !== undefined) {
      if (composerAttachmentsSnapshot.length > 0 || outgoingMessageContext !== undefined) {
        setThreadError(
          threadIdForSend,
          "Send approval feedback without attachments or added context.",
        );
        sendInFlightRef.current = false;
        return;
      }
      if (
        changedBeforeDecline ||
        approvalResponding ||
        currentRouteThreadKeyRef.current !== routeThreadKey
      ) {
        sendInFlightRef.current = false;
        return;
      }
      const sent = await sendApprovalFeedback(
        approvalFeedbackTarget,
        messageTextForSend,
        onRespondToApprovalStable,
      ).catch(() => false);
      sendInFlightRef.current = false;
      if (
        sent &&
        !draftChangedSinceSend() &&
        currentRouteThreadKeyRef.current === routeThreadKey &&
        useComposerDraftStore.getState().getComposerDraft(composerDraftTarget) ===
          draftBeforeDecline
      ) {
        promptRef.current = "";
        clearComposerDraftContent(composerDraftTarget);
        composerRef.current?.resetCursorState();
      }
      return;
    }
    const declined =
      !changedBeforeDecline &&
      !approvalResponding &&
      (await declinePendingApprovals(approvalsToDecline, onRespondToApprovalStable).catch(
        () => false,
      ));
    const draftChanged =
      changedBeforeDecline ||
      draftChangedSinceSend() ||
      useComposerDraftStore.getState().getComposerDraft(composerDraftTarget) !==
        draftBeforeDecline;
    // An approval that arrived during the decline would block the redirect; keep the draft so
    // the next send declines it too.
    const approvalArrived = pendingApprovalsRef.current.some(
      (approval) => !pendingIdsBeforeDecline.includes(approval.requestId),
    );
    if (
      !declined ||
      draftChanged ||
      approvalArrived ||
      currentRouteThreadKeyRef.current !== routeThreadKey
    ) {
      sendInFlightRef.current = false;
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      const notice = approvalRedirectNotice({
        draftChanged,
        declined,
        approvalResponding,
        approvalArrived,
      });
      if (notice !== null) {
        toastManager.add({
          type: "info",
          title: notice,
          description: "Send again when it's ready.",
        });
      }
      return;
    }
  }
  if (sendQueuesBehindSetup) {
    setSetupQueueSendThreadKey(activeThreadKey);
  } else {
    beginLocalDispatch({
      preparingWorktree: multipleModelSelections !== null || Boolean(baseBranchForWorktree),
      submissionIntent:
        submissionIntent === "background" && !isLocalDraftThread
          ? "foreground"
          : submissionIntent,
    });
    beginWorktreeSetup(
      multipleModelSelections === null && baseBranchForWorktree
        ? { environmentId: activeThread.environmentId, threadId: threadIdForSend }
        : null,
    );
  }

  const turnAttachmentsPromise = prepareTurnAttachments({
    environmentId,
    attachments: composerAttachmentsSnapshot,
    usesAttachmentUploads: turnUsesAttachmentUploads,
  });
  if (multipleModelSelections !== null) {
    await sendToMultipleModels({
      threadId: threadIdForSend,
      project: activeProject,
      branch: activeThreadBranch!,
      selections: multipleModelSelections,
      targets: multipleTargets,
      sendSnapshot,
      createdAt: messageCreatedAt,
      attachmentsPromise: turnAttachmentsPromise,
      usesAttachmentUploads: turnUsesAttachmentUploads,
      readFileBlockReason: () => readLiveAttachmentCapabilities().fileBlockReason,
      buildOutgoingMessageContext,
      isCurrentSend: () => composerSendGenerationRef.current === sendGeneration,
    });
    return;
  }
  const optimisticAttachments = optimisticMessageAttachments(composerAttachmentsSnapshot);
  if (!shouldQueueBehindActiveRun) {
    anchorNewTurn(
      scopedThreadKey(scopeThreadRef(activeThread.environmentId, threadIdForSend)),
      messageIdForSend,
    );
  }
  const optimisticMessage: ChatMessage = {
    id: messageIdForSend,
    role: "user",
    text: outgoingMessageText,
    ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
    ...(outgoingMessageContext !== undefined ? { context: outgoingMessageContext } : {}),
    runId: null,
    createdAt: messageCreatedAt,
    updatedAt: messageCreatedAt,
    streaming: false,
    ...(shouldQueueBehindActiveRun
      ? { inputIntent: "queued_turn" as const }
      : phase === "running" && dispatchMode === "steer"
        ? { inputIntent: "steer" as const }
        : {}),
  };
  // After leaving the thread during an upload, its previews were already released and the
  // message is never shown, so tracking them would keep them alive past the thread.
  if (currentRouteThreadKeyRef.current === routeThreadKey) {
    optimisticBlobPreviews.track(optimisticMessage);
  } else {
    optimisticBlobPreviews.release(optimisticMessage);
  }
  setOptimisticUserMessages((existing) => [...existing, optimisticMessage]);
  setThreadError(threadIdForSend, null);
  if (expiredTerminalContextCount > 0) {
    const toastCopy = buildExpiredTerminalContextToastCopy(
      expiredTerminalContextCount,
      "omitted",
    );
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      }),
    );
  }
  const sentDraftThreadRef = isLocalDraftThread
    ? scopeThreadRef(environmentId, threadIdForSend)
    : null;
  // Keep new-thread flows from reusing this draft while attachments and worktree setup settle.
  if (sentDraftThreadRef) markPromotedDraftThreadByRef(sentDraftThreadRef);
  promptRef.current = "";
  clearComposerDraftContent(composerDraftTarget);
  composerRef.current?.resetCursorState();

  const title = deriveThreadTitleSeed({
    text: messageTextForSend,
    attachments: composerAttachmentsSnapshot,
    fallbackLabels: sendTitleFallbackLabels(sendSnapshot),
  });
  const threadCreateModelSelection = createModelSelection(
    ctxSelectedModelSelection.instanceId,
    ctxSelectedModel || activeProjectDefaultModelSelection?.model || DEFAULT_MODEL,
    ctxSelectedModelSelection.options,
  );

  let failure: AtomCommandResult<unknown, unknown> | null = null;

  if (failure === null && isServerThread) {
    const settingsResult = await persistThreadSettingsForNextTurn({
      threadId: threadIdForSend,
      createdAt: messageCreatedAt,
      ...(localCheckoutBranchMismatch
        ? { branch: localCheckoutBranchMismatch.currentBranch }
        : {}),
      runtimeMode,
      interactionMode: sendInteractionMode,
    });
    if (settingsResult._tag === "Failure") {
      failure = settingsResult;
    }
  }

  const turnAttachmentsResult = await settlePromise(async () => {
    const turnAttachments = await turnAttachmentsPromise;
    const liveFileBlockReason = readLiveAttachmentCapabilities().fileBlockReason;
    if (liveFileBlockReason !== null) {
      throw new Error(liveFileBlockReason);
    }
    return turnAttachments;
  });
  if (failure === null && turnAttachmentsResult._tag === "Failure") {
    failure = turnAttachmentsResult;
  }

  if (failure === null && compactBeforeSend) {
    const compactResult = await startThreadTurn({
      environmentId,
      input: {
        threadId: threadIdForSend,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: "/compact",
          attachments: [],
          idleCompaction: "onReturn",
        },
        modelSelection: ctxSelectedModelSelection,
        runtimeMode,
        interactionMode: sendInteractionMode,
      },
    });
    if (compactResult._tag === "Failure") {
      failure = compactResult;
    }
  }

  let backgroundDraftOpened = false;
  let turnStartSucceeded = false;
  if (failure === null && turnAttachmentsResult._tag === "Success") {
    const bootstrap =
      isLocalDraftThread || baseBranchForWorktree
        ? {
            ...(isLocalDraftThread
              ? {
                  createThread: {
                    projectId: activeProject.id,
                    title,
                    modelSelection: threadCreateModelSelection,
                    runtimeMode,
                    interactionMode: sendInteractionMode,
                    branch: activeThreadBranch,
                    worktreePath: activeThread.worktreePath,
                    createdAt: activeThread.createdAt,
                  },
                }
              : {}),
            ...(baseBranchForWorktree
              ? {
                  prepareWorktree: {
                    projectCwd: activeProject.workspaceRoot,
                    baseBranch: baseBranchForWorktree,
                    ...(startFromOrigin ? { startFromOrigin: true } : {}),
                  },
                  runSetupScript: true,
                }
              : {}),
          }
        : undefined;
    const backgroundThreadRef =
      submissionIntent === "background" && isLocalDraftThread
        ? scopeThreadRef(environmentId, threadIdForSend)
        : null;
    if (backgroundThreadRef) beginBackgroundDraftSubmissionByRef(backgroundThreadRef);
    const startPromise = startThreadTurn({
      environmentId,
      input: {
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          attachments: turnAttachmentsResult.value,
          ...withMessageContext({
            text: outgoingMessageText,
            context: buildOutgoingMessageContext(
              boundAttachmentIds(turnAttachmentsResult.value, composerAttachmentsSnapshot),
            ),
          }),
        },
        modelSelection: ctxSelectedModelSelection,
        titleSeed: title,
        runtimeMode,
        interactionMode: sendInteractionMode,
        dispatchMode: turnDispatchMode,
        ...(bootstrap ? { bootstrap } : {}),
        createdAt: messageCreatedAt,
      },
    });
    if (backgroundThreadRef) {
      try {
        backgroundDraftOpened = Boolean(
          await handleNewThread(
            scopeProjectRef(activeProject.environmentId, activeProject.id),
            resolveBackgroundDraftWorkspaceOptions({
              envMode: sendEnvMode,
              branch: activeThreadBranch,
              startFromOrigin,
            }),
          ),
        );
      } catch (error) {
        clearBackgroundDraftSubmissionByRef(backgroundThreadRef);
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Could not open a fresh composer",
            description: error instanceof Error ? error.message : undefined,
          }),
        );
      }
    }
    const startResult = await startPromise;
    if (startResult._tag === "Failure") {
      failure = startResult;
    } else {
      turnStartSucceeded = true;
      setKeepFullHistory(routeThreadKey, false);
      clearUsageLimitsFor(routeThreadKey);
      if (turnUsesAttachmentUploads) {
        releaseDraftAttachments(composerAttachmentsSnapshot);
      }
      acknowledgeActiveThreadWoke();
      // A draft still on screen finalizes once its thread route takes over.
      if (sentDraftThreadRef) {
        if (backgroundDraftOpened || currentRouteThreadKeyRef.current !== routeThreadKey) {
          finalizePromotedDraftThreadByRef(sentDraftThreadRef);
        } else {
          clearBackgroundDraftSubmissionByRef(sentDraftThreadRef);
        }
      }
      if (backgroundThreadRef) {
        if (backgroundDraftOpened) {
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "Started in background",
              timeout: 5_000,
              actionProps: {
                children: "Open",
                onClick: () => {
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(backgroundThreadRef),
                  });
                },
              },
            }),
          );
        }
      } else if (
        submissionIntent === "background" &&
        currentRouteThreadKeyRef.current === routeThreadKey
      ) {
        handleNewThreadInActiveProject();
      }
      void recordPromptSent(environmentId);
    }
  }

  if (failure !== null) {
    if (isLocalDraftThread && draftId && draftThread) {
      restoreFailedDraftThread(
        draftId,
        draftThread,
        wasBootstrapThreadDeleted(squashAtomCommandFailure(failure))
          ? newThreadId()
          : threadIdForSend,
      );
      clearBackgroundDraftSubmissionByRef(scopeThreadRef(environmentId, threadIdForSend));
    }
    if (
      !composerDraftHasUserContent(
        useComposerDraftStore.getState().getComposerDraft(composerDraftTarget),
      )
    ) {
      setOptimisticUserMessages((existing) => {
        const next = existing.filter((message) => message.id !== messageIdForSend);
        return next.length === existing.length ? existing : next;
      });
      // The restored draft clones its images, so the sent copies are no longer used.
      optimisticBlobPreviews.release(optimisticMessage);
      const retryComposerImages = restoreComposerDraft(composerDraftTarget, sendSnapshot);
      if (currentRouteThreadKeyRef.current === routeThreadKey) {
        promptRef.current = messageTextForSend;
        composerImagesRef.current = retryComposerImages;
        composerFilesRef.current = composerFilesSnapshot;
        composerTerminalContextsRef.current = composerTerminalContextsSnapshot;
        composerRef.current?.resetCursorState({
          cursor: collapseExpandedComposerCursor(messageTextForSend, messageTextForSend.length),
          prompt: messageTextForSend,
          detectTrigger: true,
        });
      }
    }
    if (!isAtomCommandInterrupted(failure)) {
      const error = squashAtomCommandFailure(failure);
      setThreadError(
        threadIdForSend,
        error instanceof Error ? error.message : "Failed to send message.",
      );
      if (
        draftId &&
        (backgroundDraftOpened || currentRouteThreadKeyRef.current !== routeThreadKey)
      ) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title:
              submissionIntent === "background"
                ? "Background task failed"
                : "Could not start thread",
            description: error instanceof Error ? error.message : "Failed to send message.",
            actionProps: {
              children: "Open draft",
              onClick: () => {
                void navigate({ to: "/draft/$draftId", params: { draftId } });
              },
            },
          }),
        );
      }
    }
  }
  sendInFlightRef.current = false;
  setSetupQueueSendThreadKey((current) => (current === activeThreadKey ? null : current));
  if (!turnStartSucceeded) {
    setDockedDraftHeroThreadKey((currentThreadKey) =>
      currentThreadKey === activeThreadKey ? null : currentThreadKey,
    );
    if (!sendQueuesBehindSetup) resetLocalDispatch();
  }
}
