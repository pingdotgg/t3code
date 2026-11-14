import { type EnvironmentId, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { isUsageLimitsCommand } from "@t3tools/shared/usageLimits";
import { threadContextsOutsideEnvironment } from "@t3tools/shared/composerContextReferences";
import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import { mergeDirectPreviewAnnotation } from "../ChatView.logic";
import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import type { ComposerSubmissionIntent } from "../../composer-logic";
import { parseSideChatCommand } from "../../composer-logic";
import { filterTerminalContextsWithText } from "../../lib/terminalContext";
import { ensureInlineContextReferences } from "../../lib/composerContextReferences";
import { previewAnnotationContextReference } from "../../lib/composerContextRecords";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { readEnvironmentScope } from "../../state/session";
import { loadBalancingSendWarning, multipleModelSendBlock, referencedThreadContexts } from "./composerSend.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerSendRuntime } from "./useComposerSendState";

const ENVIRONMENT_UNAVAILABLE_SEND_TOAST_TRAIL_SIZE = 3;

export function readEnvironmentPresentation(environmentId: EnvironmentId) {
  return appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId);
}

function draftHasNonPromptContent(target: ComposerThreadTarget) {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  return draft ? composerDraftHasUserContent({ ...draft, prompt: "" }) : false;
}

export interface ComposerSendRequest {
  readonly dispatchMode: ComposerDispatchMode;
  readonly submissionIntent: ComposerSubmissionIntent;
  readonly directAnnotation:
    | {
        readonly annotation: PreviewAnnotationPayload;
        readonly image: ComposerImageAttachment | null;
      }
    | undefined;
}

/**
 * Rejects a send that cannot happen, running the local commands and side effects that
 * stand in for one (side chat, Codex feedback, plan follow-up, interaction mode). Returns
 * the resolved send context, or `halted` when the press is fully handled.
 */
export async function resolveComposerSend(rt: ComposerSendRuntime, request: ComposerSendRequest) {
  const { dispatchMode, submissionIntent, directAnnotation } = request;
  const {
    activeEnvironmentUnavailable,
    activePendingProgress,
    activeThread,
    activeThreadBranch,
    activeProject,
    clientSettingsHydrated,
    composerDraftTarget,
    composerRef,
    currentRouteThreadKeyRef,
    environmentId,
    environmentUnavailableSendToastSlotRef,
    feedbackUploadsInFlightRef,
    isGitRepo,
    isLocalDraftThread,
    isRevertingCheckpoint,
    isSendBusy,
    linkedEnvironments,
    loadBalancing,
    logicalProjectEnvironments,
    needsLoadBalancing,
    onAdvanceActivePendingUserInput,
    onSideChat,
    openUsageLimits,
    pendingApprovalsRef,
    promptRef,
    queuedRunEdit,
    readPendingEnvironmentChange,
    routeThreadKey,
    sendInFlightRef,
    sendQueuesBehindSetup,
    setComposerDraftPrompt,
    setThreadError,
    sideChatDisabledReason,
    threadDetailLoading,
    usageLimitsKey,
    usageLimitsOffered,
  } = rt;
  // What the user pressed send on; uploads below can take a while, and a redirect must not
  // decline approvals for a draft that changed meanwhile.
  const promptAtSend = promptRef.current;
  if (
    usageLimitsOffered &&
    usageLimitsKey !== null &&
    !directAnnotation &&
    !draftHasNonPromptContent(composerDraftTarget) &&
    isUsageLimitsCommand(promptRef.current)
  ) {
    if (openUsageLimits()) {
      promptRef.current = "";
      setComposerDraftPrompt(composerDraftTarget, "");
      composerRef.current?.resetCursorState();
    }
    return { halted: true as const };
  }

  const notifyDirectAnnotationAttached = () => {
    if (!directAnnotation) return;
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: "Annotation attached to draft",
        description: "Sending is unavailable right now. Finish the current action, then send.",
      }),
    );
  };
  if (
    !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
    !activeThread ||
    (isSendBusy && !sendQueuesBehindSetup) ||
    isRevertingCheckpoint ||
    !clientSettingsHydrated ||
    threadDetailLoading ||
    readPendingEnvironmentChange() !== null ||
    sendInFlightRef.current ||
    feedbackUploadsInFlightRef.current.has(routeThreadKey)
  ) {
    notifyDirectAnnotationAttached();
    return { halted: true as const };
  }
  if (needsLoadBalancing) {
    const draft = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
    toastManager.add({
      type: "warning",
      ...loadBalancingSendWarning({
        pending: loadBalancing.pending,
        threadContexts: draft ? referencedThreadContexts(draft) : [],
        candidateEnvironmentIds: logicalProjectEnvironments.map(
          (candidate) => candidate.environmentId,
        ),
      }),
    });
    return { halted: true as const };
  }
  if (activeEnvironmentUnavailable) {
    const toastSlot = environmentUnavailableSendToastSlotRef.current;
    environmentUnavailableSendToastSlotRef.current =
      (toastSlot + 1) % ENVIRONMENT_UNAVAILABLE_SEND_TOAST_TRAIL_SIZE;
    toastManager.add({
      ...stackedThreadToast({
        type: "warning",
        title: "Not connected: message not sent",
        description: "Reconnecting to the environment. Try again once it is connected.",
      }),
      id: `chat-send-environment-unavailable:${toastSlot}`,
    });
    return { halted: true as const };
  }
  const sendCtx = composerRef.current?.getSendContext();
  // `/side` beats an open question and a plan follow-up, which would send the text to main.
  const sideChatCommand =
    sendCtx && !directAnnotation && !queuedRunEdit.isEditing
      ? parseSideChatCommand(promptAtSend)
      : null;
  const answeringQuestion =
    Boolean(activePendingProgress) && sendCtx?.answeringPendingUserInput !== false;
  // Where side chats are unavailable, `/side` text can still be a literal answer.
  if (sideChatDisabledReason !== null && sideChatCommand && !answeringQuestion) {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Side chat not started",
        description: sideChatDisabledReason,
      }),
    );
    return { halted: true as const };
  }
  if (onSideChat && sendCtx && sideChatCommand && sideChatDisabledReason === null) {
    if (
      sendCtx.images.length > 0 ||
      sendCtx.files.length > 0 ||
      filterTerminalContextsWithText(sendCtx.terminalContexts).length > 0 ||
      sendCtx.previewAnnotations.length > 0 ||
      sendCtx.reviewComments.length > 0 ||
      sendCtx.threadContexts.length > 0 ||
      sendCtx.environmentContexts.length > 0
    ) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Side chats take text only",
          description: "Remove the attachments and context, then send it again.",
        }),
      );
      return { halted: true as const };
    }
    const started = await onSideChat(sideChatCommand.prompt);
    // Clear only what was sent; the user may have edited the draft or left meanwhile.
    if (
      started &&
      currentRouteThreadKeyRef.current === routeThreadKey &&
      promptRef.current === promptAtSend
    ) {
      promptRef.current = "";
      setComposerDraftPrompt(composerDraftTarget, "");
      composerRef.current?.resetCursorState();
    }
    return { halted: true as const };
  }
  if (answeringQuestion) {
    if (directAnnotation) {
      notifyDirectAnnotationAttached();
      return { halted: true as const };
    }
    onAdvanceActivePendingUserInput();
    return { halted: true as const };
  }
  if (!sendCtx?.providerAvailable) {
    notifyDirectAnnotationAttached();
    return { halted: true as const };
  }
  const multipleModelSelections = sendCtx.multipleModelSelections;
  const approvalFeedbackTarget = pendingApprovalsRef.current.find(
    (approval) =>
      approval.supportsFeedback && approval.requestId === sendCtx.shownPendingApprovalIds[0],
  );
  const multipleModelBlock =
    multipleModelSelections === null
      ? null
      : multipleModelSendBlock({
          selectionCount: multipleModelSelections.length,
          serverSupportsWorktreeBootstrap:
            readEnvironmentPresentation(activeThread.environmentId)?.serverConfig?.environment
              .capabilities.requiredWorktreeBootstrap === true,
          isLocalDraftThread,
          isGitRepo,
          branch: activeThreadBranch,
        });
  if (multipleModelBlock === "server-outdated") {
    setThreadError(activeThread.id, "Update this server before starting multiple models.");
    return { halted: true as const };
  }
  if (multipleModelBlock === "needs-new-git-thread") {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Choose models and a base branch",
        description:
          "Multiple models need a new thread in a Git project. Each gets its own worktree.",
      }),
    );
    return { halted: true as const };
  }
  const {
    images: sendContextImages,
    files: composerFiles,
    terminalContexts: composerTerminalContexts,
    previewAnnotations: sendContextPreviewAnnotations,
    reviewComments: composerReviewComments,
    threadContexts: composerThreadContexts,
    environmentContexts: composerEnvironmentContexts,
    selectedProvider: ctxSelectedProvider,
    selectedModel: ctxSelectedModel,
    selectedProviderModels: ctxSelectedProviderModels,
    selectedPromptEffort: ctxSelectedPromptEffort,
    selectedModelSelection: ctxSelectedModelSelection,
    interactionMode: sendInteractionMode,
    interactionModeEnabled: sendInteractionModeEnabled,
  } = sendCtx;
  const { images: composerImages, previewAnnotations: composerPreviewAnnotations } =
    mergeDirectPreviewAnnotation({
      images: sendContextImages,
      fileCount: composerFiles.length,
      previewAnnotations: sendContextPreviewAnnotations,
      direct: directAnnotation,
    });
  // A direct "send annotation" writes the draft and sends in the same tick; the reference
  // must be in the text now, not after the next render.
  const promptForSend = directAnnotation
    ? ensureInlineContextReferences(promptRef.current, [
        previewAnnotationContextReference(directAnnotation.annotation),
      ])
    : promptRef.current;
  const strandedThread = threadContextsOutsideEnvironment({
    text: promptForSend,
    records: composerThreadContexts,
    environmentId,
    linkedEnvironments,
  })[0];
  if (strandedThread) {
    const owner =
      readEnvironmentPresentation(strandedThread.environmentId)?.entry.target.label ??
      "its machine";
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Attached thread is on another machine",
        description: `This machine's agent can't read "${strandedThread.title}". Remove it, or switch back to ${owner} to send.`,
      }),
    );
    return { halted: true as const };
  }

  return {
    halted: false as const,
    activeProject,
    dispatchMode,
    activeThread,
    directAnnotation,
    submissionIntent,
    approvalFeedbackTarget,
    composerEnvironmentContexts,
    composerFiles,
    composerImages,
    composerPreviewAnnotations,
    composerReviewComments,
    composerTerminalContexts,
    composerThreadContexts,
    ctxSelectedModel,
    ctxSelectedModelSelection,
    ctxSelectedProvider,
    ctxSelectedProviderModels,
    ctxSelectedPromptEffort,
    environmentId,
    multipleModelSelections,
    promptAtSend,
    promptForSend,
    routeThreadKey,
    sendCtx,
    sendInteractionMode,
    sendInteractionModeEnabled,
  };
}
