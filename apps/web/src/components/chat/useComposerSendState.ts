import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
  type DraftId,
  type DraftSessionState,
  type DraftThreadEnvMode,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type ThreadId,
  RuntimeMode,
} from "@t3tools/contracts";
import type { CodexFeedbackSubmission } from "@t3tools/client-runtime/state/threads";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject, EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { UnifiedSettings } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type Dispatch, type SetStateAction, useLayoutEffect, useRef } from "react";
import { makeThreadErrorSetter } from "../ChatView.logic";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useClientSettingsHydrated, useEnvironmentSettings } from "../../hooks/useSettings";
import { useLinkedEnvironments } from "../../state/peerLinks";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useMultipleModelSend } from "./useMultipleModelSend";
import { usePlanFollowUpSend } from "./useProposedPlanSend";
import { draftSendState } from "./chatViewSend";
import type { ChatMessage, SessionPhase } from "../../types";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { LatestProposedPlanState } from "../../session-logic";
import type { useLogicalProjectEnvironments } from "../../hooks/useLogicalProjectEnvironments";
import type { useDraftEnvironmentRouting } from "./useDraftEnvironmentRouting";
import type { useLocalDispatchState } from "./useLocalDispatchState";
import type { usePendingThreadRequests } from "./usePendingThreadRequests";
import type { useQueuedRunEdit } from "./useQueuedRunEdit";
import type { useTimelineFollow } from "./useTimelineFollow";
import type { useUsageLimitsPanel } from "./useUsageLimitsPanel";
import type { useWorktreeSetup } from "./useWorktreeSetup";

type PendingThreadRequests = ReturnType<typeof usePendingThreadRequests>;
type LocalDispatchState = ReturnType<typeof useLocalDispatchState>;
type DraftEnvironmentRouting = ReturnType<typeof useDraftEnvironmentRouting>;
type UsageLimitsPanel = ReturnType<typeof useUsageLimitsPanel>;
type TimelineFollow = ReturnType<typeof useTimelineFollow>;

export interface ComposerSendInput {
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

const selectPlanModeEnabled = (settings: UnifiedSettings) => settings.planModeEnabled;

/**
 * The composer's send-time dependencies: the props the chat view hands over plus the
 * store, routing, and command hooks every send phase reads.
 */
export function useComposerSendState(input: ComposerSendInput) {
  const {
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    draftId,
    activeThread,
    activeThreadBranch,
    activeProposedPlan,
    isServerThread,
    runtimeMode,
    startFromOrigin,
    localCheckoutBranchMismatch,
    composerRef,
    composerDraftTarget,
    promptRef,
    isSendBusy,
    pendingApprovals,
    respondingRequestIds,
    beginLocalDispatch,
    resetLocalDispatch,
    setOptimisticUserMessages,
    setThreadError,
    anchorNewTurn,
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

  return {
    ...input,
    linkedEnvironments,
    handleNewThread,
    navigate,
    clientSettingsHydrated,
    planModeEnabled,
    startThreadTurn,
    uploadThreadFeedback,
    setComposerDraftPrompt,
    setComposerDraftTerminalContexts,
    setComposerDraftPreviewAnnotations,
    setComposerDraftReviewComments,
    setComposerDraftThreadContexts,
    setComposerDraftEnvironmentContexts,
    clearComposerDraftContent,
    sendToMultipleModels,
    submitPlanFollowUp,
    sendInFlightRef,
    composerSendGenerationRef,
    environmentUnavailableSendToastSlotRef,
    pendingApprovalsRef,
    respondingRequestIdsRef,
  };
}

export type ComposerSendRuntime = ReturnType<typeof useComposerSendState>;
