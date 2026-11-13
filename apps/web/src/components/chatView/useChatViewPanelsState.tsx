import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import {
  EMPTY_AUTO_UPDATE_ENVIRONMENTS,
  EMPTY_PENDING_FILE_SURFACE_IDS,
  EMPTY_PROVIDERS,
  EMPTY_USAGE_LIMIT_SOURCES,
} from "./chatViewTypes";
import {
  deriveAvailableRevertTurnCounts,
  deriveThreadPendingBackgroundTasks,
  resolveDraftHeroState,
  shouldShowPlanFollowUpPrompt,
  deriveLockedProvider,
  resolveFileAttachmentUrl,
  resolveComposerInteractionMode,
  resolveComposerProviderSelection,
  isCompactCommandMessage,
  makeThreadErrorSetter,
} from "../ChatView.logic";
import { usePullRequestDraftThread } from "../chat/usePullRequestDraftThread";
import { useAttachmentPreviewHandoff } from "../chat/useAttachmentPreviewHandoff";
import { useLogicalProjectEnvironments } from "../../hooks/useLogicalProjectEnvironments";
import { useStableCallback } from "../../hooks/useStableCallback";
import { usePendingThreadRequests } from "../chat/usePendingThreadRequests";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { useUsageLimitsPanel } from "../chat/useUsageLimitsPanel";
import { useWorktreeSetup } from "../chat/useWorktreeSetup";
import { type ChatFileAttachment } from "@t3tools/contracts";
import {
  codexFeedbackMessage,
  deriveWorkspaceMutationId,
  isCompleteTurnItemRow,
} from "@t3tools/client-runtime/state/threads";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useEffect, useState } from "react";
import { shallow } from "zustand/vanilla/shallow";
import {
  derivePhase,
  deriveActiveWorkStartedAt,
  findLatestProposedPlan,
  findRevertCheckpoint,
  hasActionableProposedPlan,
  isLatestRunSettled,
} from "../../session-logic";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import { useRightPanelStore } from "../../rightPanelStore";
import { getConfiguredPreviewUrls } from "../preview/previewEmptyStateLogic";
import { toastManager } from "../ui/toast";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useClientSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { useThreadCheckpointSummaries } from "../../state/entities";
import { ThreadTimeline } from "../chat/ThreadTimeline";
import { shouldShowEnvironmentIndicator } from "../BranchToolbar.logic";
import { useIncrementalTimelineEntries } from "../../hooks/useIncrementalTimelineEntries";
import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { readPreparedConnection } from "../../state/session";
import {
  type EnvironmentUnavailableState,
  useSystemComposerBanners,
} from "../chat/useSystemComposerBanners";
import { useDraftHeroLayoutTransition } from "../chat/useDraftHeroLayoutTransition";
import { useLocalDispatchState } from "../chat/useLocalDispatchState";
import { useChatViewThreadState } from "./useChatViewThreadState";

/** Project settings, environment routing, provider selection, and panel state. */
export function useChatViewPanelsState(prev: ReturnType<typeof useChatViewThreadState>) {
  const {
  activeActivityRun, activeEnvironmentBootstrapComplete, activeLatestRun, activeMessageCount,
  activeProject, activeProjectDefaultModelSelection, activeProjectKey, activeProjectScripts,
  activeProviderThread, activeRuntime, activeThread, activeThreadId,
  activeThreadKey, activeThreadLiveTokenUsage, activeThreadRef, canCheckoutPullRequestIntoThread,
  canOperateThread, clientSettingsHydrated, composerActiveProvider, composerDraftTarget,
  composerHasAttachments, composerInteractionMode, composerRef, createAttachmentAssetUrl,
  draftId, draftThread, environmentById, environmentId,
  environments, feedbackSubmissions, isLocalDraftThread, isServerThread,
  latestRunSettled, optimisticBlobPreviews, optimisticState, optimisticUserMessages,
  panelAnimationDurationMs, panelAnimationsActive, pendingFileSurfaceIdsByProject, primaryEnvironment,
  projectGroupingSettings, promptRef, providersByEnvironment, routeKind,
  routeThreadDetailRef, routeThreadKey, routeThreadRef, runlessWorkStartedAt,
  serverProjection, serverThread, serverThreadHistory, serverVisibleTurnItems,
  setComposerDraftPrompt, setHeldOptimisticUserMessages, setLocalDraftErrorsByDraftId, setLocalServerErrorsByThreadKey,
  setPendingFileSurfaceIdsByProject, settings, supportsProviderSwitchingViaHandoff, threadError,
  threadId,
  } = prev;
  const pendingFileSurfaceIds = activeProjectKey
    ? (pendingFileSurfaceIdsByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS)
    : EMPTY_PENDING_FILE_SURFACE_IDS;
  const handleFilePendingChange = (relativePath: string, pending: boolean) => {
    if (!activeProjectKey) return;
    setPendingFileSurfaceIdsByProject((currentByProject) => {
      const current = currentByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS;
      const surfaceId = `file:${relativePath}`;
      if (current.has(surfaceId) === pending) return currentByProject;
      const next = new Set(current);
      if (pending) next.add(surfaceId);
      else next.delete(surfaceId);
      const nextByProject = new Map(currentByProject);
      if (next.size === 0) nextByProject.delete(activeProjectKey);
      else nextByProject.set(activeProjectKey, next);
      return nextByProject;
    });
  };
  const handleFilePendingChangeStable = useStableCallback(handleFilePendingChange);
  const configuredPreviewUrls = getConfiguredPreviewUrls(activeProjectScripts);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops file surfaces from the right panel store once bootstrap shows the thread has no workspace
  useEffect(() => {
    if (!activeThreadRef || !activeEnvironmentBootstrapComplete) return;
    useRightPanelStore.getState().reconcileFileSurfaces(activeThreadRef, activeProject !== null);
  }, [activeEnvironmentBootstrapComplete, activeProject, activeThreadRef]);

  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const activeEnvironment =
    activeThread == null ? null : (environmentById.get(activeThread.environmentId) ?? null);
  const activeEnvironmentUnavailable =
    activeEnvironment !== null && activeEnvironment.connection.phase !== "connected";
  const activeEnvironmentUnavailableLabel = activeEnvironment?.label ?? null;
  const activeEnvironmentUnavailableState = (() => {
    if (!activeEnvironmentUnavailable || !activeEnvironmentUnavailableLabel || !activeEnvironment) {
      return null;
    }

    return {
      environmentId: activeEnvironment.environmentId,
      label: activeEnvironmentUnavailableLabel,
      connection: activeEnvironment.connection,
    };
  })() as EnvironmentUnavailableState | null;
  const activeProjectIsScratch =
    activeProject !== null &&
    isScratchProject(
      activeProject,
      environmentById.get(activeProject.environmentId)?.serverConfig?.scratchWorkspaceRoot ?? null,
    );
  const logicalProjectEnvironments = useLogicalProjectEnvironments(
    activeProject,
    activeProjectIsScratch && draftId !== null,
  );
  const hasMultipleEnvironments = logicalProjectEnvironments.length > 1;
  const canAutoBalanceEnvironments = hasMultipleEnvironments && !activeProjectIsScratch;
  const activeEnvironmentOption =
    logicalProjectEnvironments.find(
      (environment) => environment.environmentId === activeThread?.environmentId,
    ) ?? null;
  const showComposerEnvironmentIndicator = shouldShowEnvironmentIndicator({
    activeEnvironment: activeEnvironmentOption,
    canPickEnvironment: hasMultipleEnvironments,
  });

  const { handlePreparedPullRequestThreadStable, openPullRequestDialogStable } =
    usePullRequestDraftThread({
      routeKind,
      draftId,
      settings,
      projectGroupingSettings,
      activeProject,
      activeThreadKey,
      isServerThread,
      canCheckoutPullRequestIntoThread,
    });
  const serverConfig = activeThread
    ? (activeEnvironment?.serverConfig ?? null)
    : (primaryEnvironment?.serverConfig ?? null);
  const providerEnvironmentId = (activeThread ? activeEnvironment : primaryEnvironment)
    ?.environmentId;
  const providerStatuses =
    (providerEnvironmentId === undefined
      ? undefined
      : providersByEnvironment.get(providerEnvironmentId)) ?? EMPTY_PROVIDERS;
  const selectedProviderByThreadId = composerActiveProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProjectDefaultModelSelection?.instanceId ??
    null;
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider: selectedProviderByThreadId,
    threadProvider,
    providers: providerStatuses,
  });
  const modelPickerLockedProvider = supportsProviderSwitchingViaHandoff ? null : lockedProvider;
  const pullRequestsCapabilityKnown = serverConfig !== null;
  const supportsPullRequests = serverConfig !== null;
  const attachmentEnvironmentConfig = environmentById.get(environmentId)?.serverConfig ?? null;
  const attachmentUploadsCapabilityKnown = attachmentEnvironmentConfig !== null;
  const supportsQuestionAttachments = attachmentEnvironmentConfig !== null;
  const supportsAttachmentUploads = attachmentEnvironmentConfig !== null;
  const advertisedFileAttachmentBytes =
    attachmentEnvironmentConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null;
  const maxFileAttachmentBytes =
    advertisedFileAttachmentBytes === null
      ? null
      : clampFileAttachmentUploadBytes(advertisedFileAttachmentBytes);
  const envLocked = Boolean(activeThread && (activeMessageCount > 0 || activeRuntime !== null));
  // onEnvironmentChange only retargets an unsent draft. envLocked alone does not
  // rule out a started thread: one whose machine is offline never loads its
  // messages, so it would otherwise be offered a machine picker that does nothing.
  const canChangeEnvironment =
    hasMultipleEnvironments && !envLocked && draftId !== null && !draftThread?.promotedTo;

  const loadBalancingSettings = useClientSettings((settings) => ({
    loadBalancingEnabled: settings.loadBalancingEnabled,
    loadBalancingWeights: settings.loadBalancingWeights,
  }));
  const automaticEnvironment = Boolean(
    clientSettingsHydrated &&
    draftId &&
    !envLocked &&
    canAutoBalanceEnvironments &&
    loadBalancingSettings.loadBalancingEnabled &&
    draftThread?.environmentSelection !== "manual" &&
    (!composerHasAttachments || Boolean(draftThread?.loadBalancedEnvironmentId)) &&
    (!draftThread?.branch || draftThread.environmentSelection === "auto") &&
    !draftThread?.worktreePath,
  );
  const autoUpdateEnvironments = automaticEnvironment
    ? logicalProjectEnvironments.flatMap(({ environmentId }) => {
        const environment = environmentById.get(environmentId);
        return environment ? [environment] : [];
      })
    : EMPTY_AUTO_UPDATE_ENVIRONMENTS;
  const systemComposerBannerItems = useSystemComposerBanners({
    activeEnvironment,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableState,
    activeThreadEnvironmentId: activeThread?.environmentId ?? null,
    serverConfig,
    hasMultipleRegisteredEnvironments: environments.length > 1,
    automaticEnvironment,
    autoUpdateEnvironments,
  });
  const providerInstanceEntries = providerInstanceEntriesFor(
    providerStatuses,
    settings,
    activeProject?.id ?? null,
  );
  const activeThreadModelInstanceId = activeThread?.modelSelection.instanceId;
  const { selectedProviderEntry, requestedDriverKind } = resolveComposerProviderSelection({
    entries: providerInstanceEntries,
    candidateInstanceIds: [
      selectedProviderByThreadId,
      activeRuntime?.providerInstanceId,
      activeThreadModelInstanceId,
      activeProjectDefaultModelSelection?.instanceId,
    ],
    lockedProvider,
    lockedInstanceId: activeRuntime?.providerInstanceId ?? activeThreadModelInstanceId,
  });
  const selectedProvider = selectedProviderEntry?.driverKind ?? requestedDriverKind;
  const activeProviderInstanceId = selectedProviderEntry?.instanceId ?? null;
  const activeProviderStatus = selectedProviderEntry?.snapshot ?? null;
  const { enabled: interactionModeEnabled, interactionMode } = resolveComposerInteractionMode({
    planModeEnabled: settings.planModeEnabled,
    provider: activeProviderStatus,
    interactionMode:
      composerInteractionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
  });
  const conversationProviderStatus =
    providerStatuses.find((status) => status.instanceId === activeRuntime?.providerInstanceId) ??
    activeProviderStatus;
  const supportsConversationRollback =
    canOperateThread &&
    conversationProviderStatus !== null &&
    conversationProviderStatus.supportsConversationRollback !== false;
  const phase = derivePhase(activeRuntime);
  const serverThreadId = serverThread?.id;
  const serverThreadEnvironmentId = serverThread?.environmentId;
  const setThreadError = makeThreadErrorSetter({
    routeThreadRef,
    routeThreadKey,
    draftId,
    serverThreadRef:
      serverThreadId !== undefined && serverThreadEnvironmentId !== undefined
        ? { threadId: serverThreadId, environmentId: serverThreadEnvironmentId }
        : null,
    setLocalServerErrorsByThreadKey,
    setLocalDraftErrorsByDraftId,
  });
  const {
    pendingApprovals,
    pendingUserInputs,
    activePendingApproval,
    activePendingUserInput,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    respondingRequestIds,
    onRespondToApproval: onRespondToApprovalStable,
    onDismissUserInput: onDismissUserInputStable,
    onSelectActivePendingUserInputOption: onSelectActivePendingUserInputOptionStable,
    onChangeActivePendingUserInputCustomAnswer,
    onAdvanceActivePendingUserInput,
    onAdvanceActivePendingUserInputStable,
    onPreviousActivePendingUserInputQuestion: onPreviousActivePendingUserInputQuestionStable,
  } = usePendingThreadRequests({
    environmentId,
    activeThreadId,
    serverProjection,
    supportsQuestionAttachments,
    composerDraftTarget,
    setComposerDraftPrompt,
    promptRef,
    composerRef,
    setThreadError,
  });
  const [heldApprovalRequestIds, setHeldApprovalRequestIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const onHeldRequestIdsChange = useStableCallback((requestIds: ReadonlySet<string>) => {
    setHeldApprovalRequestIds((current) => (shallow(current, requestIds) ? current : requestIds));
  });
  const activeProposedPlan = (() => {
    if (!latestRunSettled) {
      return null;
    }
    return findLatestProposedPlan(serverProjection, activeLatestRun?.runId ?? null);
  })();
  const showPlanFollowUpPrompt = shouldShowPlanFollowUpPrompt({
    pendingUserInputCount: pendingUserInputs.length,
    interactionMode,
    latestTurnSettled: latestRunSettled,
    hasActionableProposedPlan: hasActionableProposedPlan(activeProposedPlan),
    hasComposerAttachments: composerHasAttachments,
  });
  // Answering an approval or question on any client resumes quota spending, so include it in the key.
  const usageLimitsKey =
    activeProviderInstanceId === null || (isServerThread && activeThread === undefined)
      ? null
      : [
          routeThreadKey,
          activeProviderInstanceId,
          activeThread?.latestRun?.runId ?? "",
          activePendingApproval?.requestId ?? activePendingUserInput?.requestId ?? "",
        ].join(":");
  const {
    banner: usageLimitsBanner,
    offered: usageLimitsOffered,
    open: openUsageLimits,
    clearFor: clearUsageLimitsFor,
  } = useUsageLimitsPanel({
    environmentId,
    threadKey: routeThreadKey,
    panelKey: usageLimitsKey,
    providerInstanceId: activeProviderInstanceId,
    providerDriver: activeProviderStatus?.driver ?? null,
    providers: providerStatuses,
    sources: serverConfig?.usageLimitSources ?? EMPTY_USAGE_LIMIT_SOURCES,
  });
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree: isLocallyPreparingWorktree,
    isSendBusy,
    backgroundSubmissionPending,
  } = useLocalDispatchState({
    activeThread,
    activeLatestRun,
    latestUserMessageId:
      serverProjection?.messages.findLast((message) => message.role === "user")?.id ?? null,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError,
  });
  const optimisticCompactionMessage = optimisticUserMessages.at(-1);
  const latestServerUserItem = serverVisibleTurnItems.findLast(
    (row) => row.item.type === "user_message",
  )?.item;
  const compactRequestIsActive =
    (isSendBusy &&
      optimisticCompactionMessage !== undefined &&
      isCompactCommandMessage(optimisticCompactionMessage)) ||
    (latestServerUserItem?.type === "user_message" &&
      latestServerUserItem.text.trim().toLowerCase() === "/compact" &&
      latestServerUserItem.attachments.length === 0 &&
      latestServerUserItem.runId === activeActivityRun?.runId &&
      !isLatestRunSettled(activeActivityRun, activeRuntime));
  const compactionSettled = serverVisibleTurnItems.some(
    ({ item }) =>
      item.type === "compaction" &&
      item.runId === activeActivityRun?.runId &&
      (item.status === "completed" ||
        item.status === "failed" ||
        item.status === "interrupted" ||
        item.status === "cancelled"),
  );
  const compactionRunning = serverVisibleTurnItems.some(
    ({ item }) =>
      item.type === "compaction" &&
      item.runId !== null &&
      item.runId === activeRuntime?.activeRunId &&
      item.status === "running",
  );
  const isCompacting =
    (isSendBusy || phase === "connecting" || phase === "running") &&
    (compactionRunning || (compactRequestIsActive && !compactionSettled));
  const isWorking =
    phase === "running" || isSendBusy || isCompacting || runlessWorkStartedAt !== null;
  const activeContextWindow = deriveLatestContextWindowSnapshot(
    serverVisibleTurnItems ?? [],
    activeThreadLiveTokenUsage,
    activeProviderThread,
  );
  const pendingBackgroundTasks = deriveThreadPendingBackgroundTasks(serverProjection);
  const activeWorkStartedAt =
    deriveActiveWorkStartedAt(activeActivityRun, activeRuntime, localDispatchStartedAt) ??
    runlessWorkStartedAt;
  const activeRunPreparing = activeActivityRun?.status === "preparing";
  const sendQueuesBehindSetup =
    isServerThread && (activeRunPreparing || activeActivityRun?.status === "starting");
  const [setupQueueSendThreadKey, setSetupQueueSendThreadKey] = useState<string | null>(null);
  const downloadFileAttachment = async (attachment: ChatFileAttachment) => {
    const connection = readPreparedConnection(environmentId);
    if (!connection) {
      toastManager.add({ type: "error", title: "The environment is not connected." });
      return;
    }

    try {
      const url = await resolveFileAttachmentUrl({
        attachment,
        environmentId,
        httpBaseUrl: connection.httpBaseUrl,
        createAssetUrl: createAttachmentAssetUrl,
      });
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.name;
      anchor.click();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not download " + attachment.name,
        description: error instanceof Error ? error.message : "The attachment is unavailable.",
      });
    }
  };
  const downloadFileAttachmentStable = useStableCallback(downloadFileAttachment);
  const openFileAttachment = (attachment: ChatFileAttachment) => {
    if (activeThreadRef) {
      useRightPanelStore.getState().openAttachment(activeThreadRef, attachment);
      return;
    }
  };
  const openFileAttachmentStable = useStableCallback(openFileAttachment);
  const { timelineAttachmentUrlById } = useAttachmentPreviewHandoff({
    environmentId,
    threadId,
    serverVisibleTurnItems,
    handoff: optimisticState.handoff,
    blobPreviews: optimisticBlobPreviews,
    setOptimisticUserMessages: setHeldOptimisticUserMessages,
  });
  const anchoredTimelineMessages = feedbackSubmissions.flatMap((submission) =>
    submission.status === "interrupted"
      ? []
      : [
          { ...codexFeedbackMessage(submission), runId: null },
          { ...codexFeedbackMessage(submission, "assistant"), runId: null },
        ],
  );
  const timelineEntriesInput = {
    optimisticMessages: optimisticUserMessages,
    anchoredMessages: anchoredTimelineMessages,
    attachmentUrlById: timelineAttachmentUrlById,
    ...(serverProjection === null
      ? {}
      : {
          attempts: serverProjection.attempts,
          nodes: serverProjection.nodes,
          plans: serverProjection.plans,
        }),
  };
  // The structure has no assistant or reasoning text, so those rows stay out of
  // ChatView's own entries (anchoring, rewind, prompt history); ThreadTimeline
  // renders every row from the live turn items.
  const serverTimelineRows = serverVisibleTurnItems.filter(isCompleteTurnItemRow);
  const hasStreamedTimelineRows =
    isServerThread && serverTimelineRows.length !== serverVisibleTurnItems.length;
  const serverTimelineEntries = useIncrementalTimelineEntries(activeThreadKey, {
    ...timelineEntriesInput,
    visibleTurnItems: serverTimelineRows,
  });
  const draftTimelineEntries = optimisticUserMessages.map(
    (message) =>
      ({
        id: message.id,
        kind: "message",
        createdAt: message.createdAt,
        message,
      }) as const,
  );
  const timelineEntries = isServerThread ? serverTimelineEntries : draftTimelineEntries;
  const timelineMessages = timelineEntries.flatMap((entry) =>
    entry.kind === "message" ? [entry.message] : [],
  );
  const timelineEmpty = timelineEntries.length === 0 && !hasStreamedTimelineRows;
  const displayedTimelineKey = activeThreadKey ?? routeThreadKey;
  const displayedThreadRef = parseScopedThreadKey(displayedTimelineKey);
  const {
    worktreeSetup,
    isPreparingWorktree,
    blocksSend: worktreeSetupBlocksSend,
    retryableRunIds: retryableWorkspacePreparationRunIds,
    begin: beginWorktreeSetup,
    cancel: cancelWorktreeSetup,
    retryPreparation: onRetryWorkspacePreparationStable,
    openSetupTerminal: onOpenWorktreeSetupTerminal,
  } = useWorktreeSetup({
    routeThreadRef,
    ownerKey: draftId ?? routeThreadKey,
    activeThread,
    threadRef: activeThreadRef,
    serverProjection,
    activityRun: activeActivityRun,
    localPreparing: isLocallyPreparingWorktree,
    sendQueuesBehindSetup,
    // Include optimistic sends to retire the row before the server echo.
    followUpSent: timelineMessages.filter((message) => message.role === "user").length > 1,
  });
  const onCancelWorktreeSetupStable = useStableCallback(() => void cancelWorktreeSetup());
  const [dockedDraftHeroThreadKey, setDockedDraftHeroThreadKey] = useState<string | null>(null);
  const draftHeroDockRequested =
    activeThreadKey !== null && dockedDraftHeroThreadKey === activeThreadKey;
  const isDraftHeroState = resolveDraftHeroState({
    isLocalDraftThread,
    hasTimelineEntries: !timelineEmpty,
    isWorking,
    draftHeroDockRequested,
    backgroundSubmissionPending,
    hasWorktreeSetupCard: worktreeSetup !== null,
  });
  const {
    transitionGroupRef: draftHeroTransitionGroupRef,
    composerAnchorRef: draftHeroComposerAnchorRef,
    captureComposerRect: captureDraftHeroComposerRect,
  } = useDraftHeroLayoutTransition(
    isDraftHeroState,
    panelAnimationsActive,
    panelAnimationDurationMs,
  );
  const turnDiffSummaries = useThreadCheckpointSummaries(routeThreadDetailRef);
  const availableRevertTurnCounts = deriveAvailableRevertTurnCounts(serverProjection);
  // A paged history window cannot identify the first loaded run as the thread start.
  const threadStartCheckpointReady =
    !serverThreadHistory.hasMoreHistory &&
    findRevertCheckpoint(serverProjection?.checkpoints ?? [], 0) !== undefined;

  const workspaceMutationId = deriveWorkspaceMutationId(
    serverVisibleTurnItems,
    turnDiffSummaries.at(-1)?.completedAt ?? null,
  );

  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.workspaceRoot },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const gitStatusCwd = activeThread?.worktreePath ?? gitCwd;
  const gitStatusQuery = useEnvironmentQuery(
    gitStatusCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: gitStatusCwd },
        }),
  );

  return {
    ...prev, pendingFileSurfaceIds, handleFilePendingChange, handleFilePendingChangeStable, configuredPreviewUrls, primaryEnvironmentId,
    activeEnvironment, activeEnvironmentUnavailable, activeEnvironmentUnavailableLabel, activeEnvironmentUnavailableState, activeProjectIsScratch, logicalProjectEnvironments,
    hasMultipleEnvironments, canAutoBalanceEnvironments, activeEnvironmentOption, showComposerEnvironmentIndicator, handlePreparedPullRequestThreadStable, openPullRequestDialogStable,
    serverConfig, providerEnvironmentId, providerStatuses, selectedProviderByThreadId, threadProvider, lockedProvider,
    modelPickerLockedProvider, pullRequestsCapabilityKnown, supportsPullRequests, attachmentEnvironmentConfig, attachmentUploadsCapabilityKnown, supportsQuestionAttachments,
    supportsAttachmentUploads, advertisedFileAttachmentBytes, maxFileAttachmentBytes, envLocked, canChangeEnvironment, loadBalancingSettings,
    automaticEnvironment, autoUpdateEnvironments, systemComposerBannerItems, providerInstanceEntries, activeThreadModelInstanceId, selectedProviderEntry,
    requestedDriverKind, selectedProvider, activeProviderInstanceId, activeProviderStatus, interactionModeEnabled, interactionMode,
    conversationProviderStatus, supportsConversationRollback, phase, serverThreadId, serverThreadEnvironmentId, setThreadError,
    pendingApprovals, pendingUserInputs, activePendingApproval, activePendingUserInput, activePendingDraftAnswers, activePendingQuestionIndex,
    activePendingProgress, activePendingResolvedAnswers, activePendingIsResponding, respondingRequestIds, onRespondToApprovalStable, onDismissUserInputStable,
    onSelectActivePendingUserInputOptionStable, onChangeActivePendingUserInputCustomAnswer, onAdvanceActivePendingUserInput, onAdvanceActivePendingUserInputStable, onPreviousActivePendingUserInputQuestionStable, heldApprovalRequestIds,
    setHeldApprovalRequestIds, onHeldRequestIdsChange, activeProposedPlan, showPlanFollowUpPrompt, usageLimitsKey, usageLimitsBanner,
    usageLimitsOffered, openUsageLimits, clearUsageLimitsFor, beginLocalDispatch, resetLocalDispatch, localDispatchStartedAt,
    isLocallyPreparingWorktree, isSendBusy, backgroundSubmissionPending, optimisticCompactionMessage, latestServerUserItem, compactRequestIsActive,
    compactionSettled, compactionRunning, isCompacting, isWorking, activeContextWindow, pendingBackgroundTasks,
    activeWorkStartedAt, activeRunPreparing, sendQueuesBehindSetup, setupQueueSendThreadKey, setSetupQueueSendThreadKey, downloadFileAttachment,
    downloadFileAttachmentStable, openFileAttachment, openFileAttachmentStable, timelineAttachmentUrlById, anchoredTimelineMessages, timelineEntriesInput,
    serverTimelineRows, hasStreamedTimelineRows, serverTimelineEntries, draftTimelineEntries, timelineEntries, timelineMessages,
    timelineEmpty, displayedTimelineKey, displayedThreadRef, worktreeSetup, isPreparingWorktree, worktreeSetupBlocksSend,
    retryableWorkspacePreparationRunIds, beginWorktreeSetup, cancelWorktreeSetup, onRetryWorkspacePreparationStable, onOpenWorktreeSetupTerminal, onCancelWorktreeSetupStable,
    dockedDraftHeroThreadKey, setDockedDraftHeroThreadKey, draftHeroDockRequested, isDraftHeroState, draftHeroTransitionGroupRef, draftHeroComposerAnchorRef,
    captureDraftHeroComposerRect, turnDiffSummaries, availableRevertTurnCounts, threadStartCheckpointReady, workspaceMutationId, gitCwd,
    gitStatusCwd, gitStatusQuery,
  };
}
