import {
  mergeDirectPreviewAnnotation,
  resolveBackgroundDraftWorkspaceOptions,
  shouldDockDraftHeroForSubmission,
  restorePlanFollowUpComposer,
  buildExpiredTerminalContextToastCopy,
  deriveComposerSendState,
  boundAttachmentIds,
  formatOutgoingPrompt,
  optimisticMessageAttachments,
  planComposerTurn,
  sendTitleFallbackLabels,
  snapshotComposerSend,
  withMessageContext,
  makeThreadErrorSetter,
} from "../ChatView.logic";
import { isUsageLimitsCommand } from "@t3tools/shared/usageLimits";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_MODEL,
  type EnvironmentId,
  type ModelSelection,
  type PreviewAnnotationPayload,
  type ThreadId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { wasBootstrapThreadDeleted } from "@t3tools/client-runtime/errors";
import {
  declinePendingApprovals,
  sendApprovalFeedback,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { createModelSelection } from "@t3tools/shared/model";
import { type SetStateAction, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  type ComposerSubmissionIntent,
  collapseExpandedComposerCursor,
  parseSideChatCommand,
  parseStandaloneComposerSlashCommand,
} from "../../composer-logic";
import { resolvePlanFollowUpSubmission } from "../../proposedPlan";
import { type ChatMessage } from "../../types";
import { recordPromptSent } from "../GitHubStarPrompt";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { newMessageId, newThreadId } from "~/lib/utils";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  beginBackgroundDraftSubmissionByRef,
  clearBackgroundDraftSubmissionByRef,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  restoreFailedDraftThread,
  composerDraftHasUserContent,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  useComposerDraftStore,
  DraftId,
} from "../../composerDraftStore";
import {
  filterTerminalContextsWithText,
  type TerminalContextDraft,
} from "../../lib/terminalContext";
import { ensureInlineContextReferences } from "../../lib/composerContextReferences";
import {
  buildMessageContext,
  previewAnnotationContextReference,
} from "../../lib/composerContextRecords";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { runMobileComposerTransition } from "./draftHeroTransition";
import { useClientSettingsHydrated, useEnvironmentSettings } from "../../hooks/useSettings";
import { environmentPresentations } from "../../state/presentation";
import {
  approvalRedirectNotice,
  loadBalancingSendWarning,
  multipleModelSendBlock,
  referencedThreadContexts,
} from "./composerSend.logic";
import { usePlanFollowUpSend } from "./useProposedPlanSend";
import { useMultipleModelSend } from "./useMultipleModelSend";
import { type ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseDraftAttachments,
  retryAttachmentUpload,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";
import { useLinkedEnvironments } from "../../state/peerLinks";
import { readEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  threadContextsOutsideEnvironment,
} from "@t3tools/shared/composerContextReferences";
import {
  draftSendState,
  type MultipleModelTarget,
  resolveMultipleModelTargets,
  prepareTurnAttachments,
  restoreComposerDraft,
} from "./chatViewSend";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { UnifiedSettings } from "@t3tools/contracts";
import type { Dispatch } from "react";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { SessionPhase } from "../../types";
import type { DraftSessionState } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { useLogicalProjectEnvironments } from "../../hooks/useLogicalProjectEnvironments";
import type { LatestProposedPlanState } from "../../session-logic";
import type { useDraftEnvironmentRouting } from "./useDraftEnvironmentRouting";
import type { useLocalDispatchState } from "./useLocalDispatchState";
import type { usePendingThreadRequests } from "./usePendingThreadRequests";
import type { useQueuedRunEdit } from "./useQueuedRunEdit";
import type { useTimelineFollow } from "./useTimelineFollow";
import type { useUsageLimitsPanel } from "./useUsageLimitsPanel";
import type { useWorktreeSetup } from "./useWorktreeSetup";

const ENVIRONMENT_UNAVAILABLE_SEND_TOAST_TRAIL_SIZE = 3;

const selectPlanModeEnabled = (settings: UnifiedSettings) => settings.planModeEnabled;

function readEnvironmentPresentation(environmentId: EnvironmentId) {
  return appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId);
}

function draftHasNonPromptContent(target: ComposerThreadTarget) {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  return draft ? composerDraftHasUserContent({ ...draft, prompt: "" }) : false;
}

type PendingThreadRequests = ReturnType<typeof usePendingThreadRequests>;
type LocalDispatchState = ReturnType<typeof useLocalDispatchState>;
type DraftEnvironmentRouting = ReturnType<typeof useDraftEnvironmentRouting>;
type UsageLimitsPanel = ReturnType<typeof useUsageLimitsPanel>;
type TimelineFollow = ReturnType<typeof useTimelineFollow>;

interface ComposerSendInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly draftId: DraftId | null;
  readonly draftThread: DraftSessionState | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeThreadKey: string | null;
  readonly activeThreadBranch: string | null;
  readonly activeProject: EnvironmentProject | null;
  readonly activeProjectDefaultModelSelection: ModelSelection | null;
  readonly activeProposedPlan: LatestProposedPlanState | null;
  readonly activeMessageCount: number;
  readonly isServerThread: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isGitRepo: boolean;
  readonly phase: SessionPhase;
  readonly runtimeMode: RuntimeMode;
  readonly sendEnvMode: DraftThreadEnvMode;
  readonly startFromOrigin: boolean;
  readonly localCheckoutBranchMismatch: {
    readonly threadBranch: string;
    readonly currentBranch: string;
  } | null;
  readonly logicalProjectEnvironments: ReturnType<typeof useLogicalProjectEnvironments>;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly promptRef: { current: string };
  readonly composerImagesRef: { current: ComposerImageAttachment[] };
  readonly composerFilesRef: { current: ComposerFileAttachment[] };
  readonly composerTerminalContextsRef: { current: TerminalContextDraft[] };
  readonly feedbackUploadsInFlightRef: { readonly current: Set<string> };
  readonly queuedRunEdit: ReturnType<typeof useQueuedRunEdit>;
  readonly isRevertingCheckpoint: boolean;
  readonly threadDetailLoading: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly isSendBusy: boolean;
  readonly sendQueuesBehindSetup: boolean;
  readonly isDraftHeroState: boolean;
  readonly panelAnimationsActive: boolean;
  readonly panelAnimationDurationMs: number;
  readonly keepFullHistory: boolean;
  readonly resumeCompactionTokens: number | null;
  readonly showPlanFollowUpPrompt: boolean;
  readonly usageLimitsKey: string | null;
  readonly usageLimitsOffered: boolean;
  readonly openUsageLimits: UsageLimitsPanel["open"];
  readonly clearUsageLimitsFor: UsageLimitsPanel["clearFor"];
  readonly needsLoadBalancing: boolean;
  readonly loadBalancing: DraftEnvironmentRouting["loadBalancing"];
  readonly readPendingEnvironmentChange: DraftEnvironmentRouting["readPendingEnvironmentChange"];
  readonly pendingApprovals: PendingThreadRequests["pendingApprovals"];
  readonly respondingRequestIds: PendingThreadRequests["respondingRequestIds"];
  readonly activePendingProgress: PendingThreadRequests["activePendingProgress"];
  readonly onAdvanceActivePendingUserInput: PendingThreadRequests["onAdvanceActivePendingUserInput"];
  readonly onRespondToApproval: PendingThreadRequests["onRespondToApproval"];
  readonly beginLocalDispatch: LocalDispatchState["beginLocalDispatch"];
  readonly resetLocalDispatch: LocalDispatchState["resetLocalDispatch"];
  readonly beginWorktreeSetup: ReturnType<typeof useWorktreeSetup>["begin"];
  readonly captureDraftHeroComposerRect: () => void;
  readonly setDockedDraftHeroThreadKey: Dispatch<SetStateAction<string | null>>;
  readonly setSetupQueueSendThreadKey: Dispatch<SetStateAction<string | null>>;
  readonly setOptimisticUserMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  /** Takes ownership of, and later releases, an optimistic message's blob previews. */
  readonly optimisticBlobPreviews: {
    readonly track: (message: ChatMessage) => void;
    readonly release: (message: ChatMessage) => void;
  };
  readonly setFeedbackSubmissionsByThreadKey: Dispatch<
    SetStateAction<Record<string, ReadonlyArray<CodexFeedbackSubmission>>>
  >;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
  readonly setKeepFullHistory: (threadKey: string, keep: boolean) => void;
  readonly anchorNewTurn: TimelineFollow["anchorNewTurn"];
  readonly acknowledgeActiveThreadWoke: () => void;
  readonly handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  /** Resolves true once the side chat started and got the prompt. */
  readonly onSideChat?: ((prompt: string) => Promise<boolean>) | undefined;
  /** Refuses `/side` with this reason and keeps the draft. */
  readonly sideChatDisabledReason: string | null;
  readonly handleNewThreadInActiveProject: () => void;
  readonly persistThreadSettingsForNextTurn: (input: {
    threadId: ThreadId;
    createdAt: string;
    branch?: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<AtomCommandResult<void, unknown>>;
}

/**
 * Everything the composer's send button can start: a turn on this thread or a new one,
 * a multiple-model start, a queued or steering message, a plan follow-up or implementation
 * thread, a feedback upload, and resuming an interrupted run. Each path restores the draft
 * when it fails.
 */
export function useComposerSend(input: ComposerSendInput) {
  const {
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    draftId,
    draftThread,
    activeThread,
    activeThreadKey,
    activeThreadBranch,
    activeProject,
    activeProjectDefaultModelSelection,
    activeProposedPlan,
    activeMessageCount,
    isServerThread,
    isLocalDraftThread,
    isGitRepo,
    phase,
    runtimeMode,
    sendEnvMode,
    startFromOrigin,
    localCheckoutBranchMismatch,
    logicalProjectEnvironments,
    providerInstanceEntries,
    composerRef,
    composerDraftTarget,
    promptRef,
    composerImagesRef,
    composerFilesRef,
    composerTerminalContextsRef,
    feedbackUploadsInFlightRef,
    queuedRunEdit,
    isRevertingCheckpoint,
    threadDetailLoading,
    activeEnvironmentUnavailable,
    isSendBusy,
    sendQueuesBehindSetup,
    isDraftHeroState,
    panelAnimationsActive,
    panelAnimationDurationMs,
    keepFullHistory,
    resumeCompactionTokens,
    showPlanFollowUpPrompt,
    usageLimitsKey,
    usageLimitsOffered,
    openUsageLimits,
    clearUsageLimitsFor,
    needsLoadBalancing,
    loadBalancing,
    readPendingEnvironmentChange,
    pendingApprovals,
    respondingRequestIds,
    activePendingProgress,
    onAdvanceActivePendingUserInput,
    onRespondToApproval: onRespondToApprovalStable,
    beginLocalDispatch,
    resetLocalDispatch,
    beginWorktreeSetup,
    captureDraftHeroComposerRect,
    setDockedDraftHeroThreadKey,
    setSetupQueueSendThreadKey,
    setOptimisticUserMessages,
    optimisticBlobPreviews,
    setFeedbackSubmissionsByThreadKey,
    setThreadError,
    setKeepFullHistory,
    anchorNewTurn,
    acknowledgeActiveThreadWoke,
    handleInteractionModeChange,
    onSideChat,
    sideChatDisabledReason,
    handleNewThreadInActiveProject,
    persistThreadSettingsForNextTurn,
  } = input;
  const linkedEnvironments = useLinkedEnvironments(environmentId);
  const handleNewThread = useNewThreadHandler();
  const navigate = useNavigate();
  const clientSettingsHydrated = useClientSettingsHydrated();
  const planModeEnabled = useEnvironmentSettings(environmentId, selectPlanModeEnabled);
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const uploadThreadFeedback = useOrchestrationCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftPreviewAnnotations = useComposerDraftStore(
    (store) => store.setPreviewAnnotations,
  );
  const setComposerDraftReviewComments = useComposerDraftStore((store) => store.setReviewComments);
  const setComposerDraftThreadContexts = useComposerDraftStore((store) => store.setThreadContexts);
  const setComposerDraftEnvironmentContexts = useComposerDraftStore(
    (store) => store.setEnvironmentContexts,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const sendToMultipleModels = useMultipleModelSend({
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    draftId,
    composerDraftTarget,
    composerRef,
    promptRef,
    runtimeMode,
    startFromOrigin,
    resetLocalDispatch,
    setThreadError,
  });
  const submitPlanFollowUp = usePlanFollowUpSend({
    environmentId,
    routeThreadKey,
    activeThread,
    activeThreadBranch,
    activeProposedPlan,
    isServerThread,
    isSendBusy,
    composerRef,
    beginLocalDispatch,
    resetLocalDispatch,
    runtimeMode,
    localCheckoutBranchMismatch,
    setOptimisticUserMessages,
    setThreadError,
    anchorNewTurn,
    persistThreadSettingsForNextTurn,
  });
  const { sendInFlight: sendInFlightRef } = draftSendState(routeThreadKey);
  const composerSendGenerationRef = useRef(0);
  const environmentUnavailableSendToastSlotRef = useRef(0);
  // A send awaits uploads before it declines, so it reads the approvals pending by then.
  const pendingApprovalsRef = useRef(pendingApprovals);
  const respondingRequestIdsRef = useRef(respondingRequestIds);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors approvals into refs that an async send reads after awaiting uploads
  useLayoutEffect(() => {
    pendingApprovalsRef.current = pendingApprovals;
    respondingRequestIdsRef.current = respondingRequestIds;
  }, [pendingApprovals, respondingRequestIds]);

  const onSend = async (
    e?: { preventDefault: () => void },
    dispatchMode: ComposerDispatchMode = "auto",
    submissionIntent: ComposerSubmissionIntent = "foreground",
    directAnnotation?: {
      annotation: PreviewAnnotationPayload;
      image: ComposerImageAttachment | null;
    },
  ) => {
    e?.preventDefault();
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
      return;
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
      return;
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
      return;
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
      return;
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
      return;
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
        return;
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
      return;
    }
    if (answeringQuestion) {
      if (directAnnotation) {
        notifyDirectAnnotationAttached();
        return;
      }
      onAdvanceActivePendingUserInput();
      return;
    }
    if (!sendCtx?.providerAvailable) {
      notifyDirectAnnotationAttached();
      return;
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
      return;
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
      return;
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
      return;
    }
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
      return;
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
        return;
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

      return;
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
        return;
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
        promptRef.current = followUpPromptSnapshot;
        composerTerminalContextsRef.current = [...followUpTerminalContexts];
        restorePlanFollowUpComposer({
          snapshot: {
            prompt: followUpPromptSnapshot,
            terminalContexts: followUpTerminalContexts,
            reviewComments: followUpReviewComments,
            previewAnnotations: followUpPreviewAnnotations,
            threadContexts: followUpThreadContexts,
            environmentContexts: followUpEnvironmentContexts,
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
      return;
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
      return;
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
      return;
    }
    if (!activeProject) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Choose a project first",
          description: "This draft no longer points to an available project.",
        }),
      );
      return;
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
      return;
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
      return;
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
        return;
      }
      if (composerRef.current?.validateProviderInput(resolved.text) === false) return;
      multipleTargets.push(resolved);
    }

    sendInFlightRef.current = true;
    const sendGeneration = ++composerSendGenerationRef.current;
    const attachmentCapabilitiesBeforeUpload = readLiveAttachmentCapabilities();
    if (attachmentCapabilitiesBeforeUpload.fileBlockReason !== null) {
      sendInFlightRef.current = false;
      setThreadError(threadIdForSend, attachmentCapabilitiesBeforeUpload.fileBlockReason);
      return;
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
        return;
      }
      if (getUploadedAttachments({ environmentId, images: composerAttachmentsSnapshot }) === null) {
        sendInFlightRef.current = false;
        setThreadError(threadIdForSend, "Retry or remove failed uploads before sending.");
        return;
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
      return;
    }
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
  };

  return { onSend };
}
