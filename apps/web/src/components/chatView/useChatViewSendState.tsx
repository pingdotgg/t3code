import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { queuedRunEditBlockedReason } from "@t3tools/client-runtime/queued-run-edit";
import { useTimelineRewind } from "../chat/useTimelineRewind";
import { useComposerSend } from "../chat/useComposerSend";
import { useComposerResume } from "../chat/useComposerResume";
import { useImplementPlanInNewThread } from "../chat/useProposedPlanSend";
import { useStableCallback } from "../../hooks/useStableCallback";
import { orchestrationV2WorktreePending, type PreviewAnnotationPayload } from "@t3tools/contracts";
import { getUserQueuedThreadRuns } from "@t3tools/client-runtime/state/thread-workflows";
import { HandoffRow } from "../chat/V2LifecycleRow";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { use, useEffect, useRef } from "react";
import { GuestPendingMessages } from "../chat/GuestShareControls";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  isSameSidebarThreadRef,
  useSidebarPendingFileDropStore,
} from "../../sidebarPendingFileDropStore";
import { type ComposerImageAttachment } from "../../composerDraftStore";
import { type ChatComposerHandle } from "../chat/ChatComposer";
import { openExpandedImagePreview } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { QueuedRunsControl } from "../chat/QueuedRunsControl";
import { ThreadNow } from "../chat/ThreadNow";
import { useChatViewComposerState } from "./useChatViewComposerState";

/** Send/resume wiring, timeline footer, and sidebar file drops. */
export function useChatViewSendState(prev: ReturnType<typeof useChatViewComposerState>) {
  const {
  acknowledgeActiveThreadWoke, activeEnvironmentUnavailable, activeEnvironmentUnavailableLabel, activeMessageCount,
  activePendingProgress, activeProject, activeProjectDefaultModelSelection, activeProposedPlan,
  activeThread, activeThreadBranch, activeThreadKey, anchorNewTurn,
  attentionNow, beginLocalDispatch, beginWorktreeSetup, cancelWorktreeSetup,
  captureDraftHeroComposerRect, childInputNow, clearUsageLimitsFor, clientSettingsHydrated,
  compactDisabled, composerDraftTarget, composerFilesRef, composerImagesRef,
  composerRef, composerTerminalContextsRef, currentRouteThreadKeyRef, defaultRuntimeMode,
  delayedThreadSyncPhase, draftId, draftThread, environmentId,
  feedbackUploading, feedbackUploadsInFlightRef, goalNow, handleInteractionModeChange,
  handleNewThreadInActiveProject, hasHeldQueuedRuns, interactionMode, isDraftHeroState,
  isGitRepo, isLocalDraftThread, isRevertingCheckpoint, isSendBusy,
  isServerThread, isSubagentThread, keepFullHistory, keybindings,
  loadBalancing, localCheckoutBranchMismatch, logicalProjectEnvironments, needsLoadBalancing,
  onAdvanceActivePendingUserInput, onOpenRelatedThreadStable, onOpenToolDiffStable, onRespondToApprovalStable,
  openFileAttachmentStable, openUsageLimits, optimisticBlobPreviews, optimisticUserMessages,
  panelAnimationDurationMs, panelAnimationsActive, pendingApprovals, pendingHandoff,
  pendingUserInputs, persistThreadSettingsForNextTurn, phase, promptRef,
  providerInstanceEntries, providerStatuses, queuedRunEdit, queuedRunsControlRef,
  readPendingEnvironmentChange, resetLocalDispatch, respondingRequestIds, resumableRunId,
  resumeCompactionTokens, routeThreadKey, routeThreadRef, runSideChatShellCommandStable,
  runtimeMode, scrollToEnd, sendEnvMode, sendInFlightRef,
  sendQueuesBehindSetup, sendStandaloneCommand, serverConfig, serverProjection,
  setDockedDraftHeroThreadKey, setDraftThreadContext, setFeedbackSubmissionsByThreadKey, setKeepFullHistory,
  setOptimisticUserMessages, setSetupQueueSendThreadKey, setThreadError, setWorkLocallyResendDraftId,
  showPlanFollowUpPrompt, sideChat, sideChatsOffered, startFromOrigin,
  supportsConversationRollback, threadDetailLoading, threadId, threadStatusLine,
  timelineLiveFollowEnabled, timelineMessages, timestampFormat, usageLimitsKey,
  usageLimitsOffered, workLocallyResendDraftId, workNow, worktreeSetup,
  } = prev;
  const sideChatDisabledReason =
    activeThread?.lineage.sideChat === true
      ? "Side chats cannot start side chats."
      : isSubagentThread
        ? "Subagent threads cannot start side chats."
        : serverConfig === null
          ? "Side chats are not ready yet. Try again in a moment."
          : serverConfig.environment.capabilities.sideChats !== true
            ? "Update this environment's T3 Code server to use side chats."
            : sideChatsOffered && !isServerThread
              ? "Side chats start after the first message."
              : sideChat.available &&
                  orchestrationV2WorktreePending(
                    activeThread?.worktreePath ?? null,
                    serverProjection?.runs ?? [],
                  )
                ? "Available once the thread's worktree is set up."
                : null;
  const openSideChatStable = useStableCallback(() => void sideChat.open());
  const sendSideChatStable = useStableCallback((prompt: string) => sideChat.open(prompt));
  const { onConfirmRevertStable, onForkFromRunStable, onRevertTimelineTurnStable } =
    useTimelineRewind({
      environmentId,
      routeThreadRef,
      routeThreadKey,
      currentRouteThreadKeyRef,
      serverProjection,
      activeThread,
      timelineMessages,
      phase,
      isSendBusy,
      isRevertingCheckpoint,
      supportsConversationRollback,
      activeEnvironmentUnavailable,
      activeEnvironmentUnavailableLabel,
      promptRef,
      composerRef,
      composerDraftTarget,
      setThreadError,
    });
  const onCompactContext = () => {
    if (compactDisabled) return;
    void sendStandaloneCommand("/compact", "Failed to compact context.");
  };

  const { onResume, isResuming } = useComposerResume({
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    activeThread,
    resumableRunId,
    hasHeldQueuedRuns,
    isSendBusy,
    isRevertingCheckpoint,
    threadDetailLoading,
    activeEnvironmentUnavailable,
    runtimeMode,
    interactionMode,
    localCheckoutBranchMismatch,
    composerRef,
    persistThreadSettingsForNextTurn,
    clearUsageLimitsFor,
    scrollToEnd,
    setThreadError,
  });
  const onImplementPlanInNewThread = useImplementPlanInNewThread({
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
    activeProject,
    activeEnvironmentUnavailable,
    defaultRuntimeMode,
  });
  const { onSend } = useComposerSend({
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
    optimisticBlobPreviews: {
      track: (message) => optimisticBlobPreviews.track(threadId, message),
      release: (message) => optimisticBlobPreviews.release(threadId, message),
    },
    setFeedbackSubmissionsByThreadKey,
    setThreadError,
    setKeepFullHistory,
    anchorNewTurn,
    acknowledgeActiveThreadWoke,
    handleInteractionModeChange,
    onSideChat: sideChat.available ? sendSideChatStable : undefined,
    sideChatDisabledReason,
    handleNewThreadInActiveProject,
    persistThreadSettingsForNextTurn,
  });
  const onImplementPlanInNewThreadStable = useStableCallback(onImplementPlanInNewThread);

  const onWorktreeSetupWorkLocally = () => {
    if (!worktreeSetup || worktreeSetup.phase !== "running" || !draftId) {
      return;
    }
    void cancelWorktreeSetup().then((cancelled) => {
      if (cancelled) setWorkLocallyResendDraftId(draftId);
    });
  };
  const onWorktreeSetupWorkLocallyStable = useStableCallback(onWorktreeSetupWorkLocally);
  const onComposerSendStable = useStableCallback(onSend);
  const sendPreviewAnnotation = (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => {
    void onSend(undefined, "auto", "foreground", { annotation, image });
  };
  const sendPreviewAnnotationStable = useStableCallback(sendPreviewAnnotation);
  const onComposerResumeStable = useStableCallback(onResume);
  const onComposerCompactContextStable = useStableCallback(onCompactContext);
  // Read from the projection the footer renders, so the scroll below sees the new message.
  const pendingGuestMessageIds =
    serverProjection?.thread.guestShare?.messages.flatMap((message) =>
      message.status === "pending" ? [message.id] : [],
    ) ?? [];
  const pendingGuestMessageCount = pendingGuestMessageIds.length;
  const pendingGuestMessageKey = pendingGuestMessageIds.join(",");
  const previousPendingGuestMessagesRef = useRef({
    threadKey: routeThreadKey,
    key: pendingGuestMessageKey,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the timeline list to the end when a new pending guest message joins its footer
  useEffect(() => {
    const previous = previousPendingGuestMessagesRef.current;
    previousPendingGuestMessagesRef.current = {
      threadKey: routeThreadKey,
      key: pendingGuestMessageKey,
    };
    // Opening another thread is not a new message; its own scroll position wins.
    if (previous.threadKey !== routeThreadKey) return;
    // Pending guest messages sit in the list footer, which the list does not follow on its own.
    // The follow flag reflects the owner's position before the footer grew; a live measure may not.
    // Any new id counts, even when another one was resolved in the same update.
    const previousIds = new Set(previous.key.split(","));
    const hasNewMessage = pendingGuestMessageKey
      .split(",")
      .some((id) => id !== "" && !previousIds.has(id));
    if (hasNewMessage && timelineLiveFollowEnabled) scrollToEnd(true);
  }, [routeThreadKey, pendingGuestMessageKey, timelineLiveFollowEnabled, scrollToEnd]);
  const queuedRunsControl =
    isServerThread && activeThread ? (
      <>
        <QueuedRunsControl
          ref={queuedRunsControlRef}
          steerShortcutLabel={shortcutLabelForCommand(keybindings, "thread.steerQueuedMessage", {
            context: { terminalFocus: false },
          })}
          editShortcutLabel={shortcutLabelForCommand(keybindings, "thread.editQueuedMessage", {
            context: { composerFocus: true },
          })}
          environmentId={activeThread.environmentId}
          threadId={activeThread.id}
          optimisticMessages={optimisticUserMessages}
          editingRunId={queuedRunEdit.editingRunId}
          editBlockedReason={queuedRunEditBlockedReason({
            openQuestionCount: pendingUserInputs.length,
          })}
          onEditQueuedRun={queuedRunEdit.beginEdit}
          onCancelEdit={queuedRunEdit.cancelEdit}
          timestampFormat={timestampFormat}
          onOpenThread={onOpenRelatedThreadStable}
        />
      </>
    ) : null;
  const resendAfterWorkLocally = () => {
    setWorkLocallyResendDraftId(null);
    void onComposerSendStable();
  };
  const resendAfterWorkLocallyStable = useStableCallback(resendAfterWorkLocally);
  const workLocallyResendReady =
    workLocallyResendDraftId !== null &&
    workLocallyResendDraftId === draftId &&
    isLocalDraftThread &&
    !isSendBusy &&
    !isRevertingCheckpoint &&
    !threadDetailLoading &&
    clientSettingsHydrated &&
    !needsLoadBalancing &&
    !activeEnvironmentUnavailable &&
    !activePendingProgress &&
    !feedbackUploading;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- switches the draft to local mode, then resends the waiting message once sending is idle
  useEffect(() => {
    if (
      !workLocallyResendReady ||
      sendInFlightRef.current ||
      feedbackUploadsInFlightRef.current.has(routeThreadKey)
    ) {
      return;
    }
    if (sendEnvMode !== "local") {
      setDraftThreadContext(composerDraftTarget, { envMode: "local", startFromOrigin: false });
      return;
    }
    resendAfterWorkLocallyStable();
  }, [
    composerDraftTarget,
    feedbackUploadsInFlightRef,
    resendAfterWorkLocallyStable,
    sendInFlightRef,
    routeThreadKey,
    sendEnvMode,
    setDraftThreadContext,
    workLocallyResendReady,
  ]);

  const onExpandTimelineImage = (preview: ExpandedImagePreview) => {
    openExpandedImagePreview(routeThreadKey, preview);
  };
  const onExpandTimelineImageStable = useStableCallback(onExpandTimelineImage);
  const shownThreadSyncPhase = activeEnvironmentUnavailable ? null : delayedThreadSyncPhase;
  const hasThreadNow =
    attentionNow !== null || workNow !== null || goalNow !== null || shownThreadSyncPhase !== null;
  const queuedRunCount = serverProjection ? getUserQueuedThreadRuns(serverProjection).length : 0;
  // The queue control is mounted for every server thread but joins the footer only while it shows
  // something, by its own rule: an optimistic message stops counting once the server has it.
  const hasQueuedTurns =
    queuedRunCount > 0 ||
    optimisticUserMessages.some(
      (message) =>
        message.inputIntent === "queued_turn" &&
        !serverProjection?.messages.some((committed) => committed.id === message.id),
    );
  const scrollToEndSummary =
    [childInputNow?.waitingLabel ?? null, queuedRunCount === 0 ? null : `${queuedRunCount} queued`]
      .filter((part) => part !== null)
      .join(" · ") || null;
  // The end of the timeline holds the thread's present and next turns: what it is doing now,
  // its lifecycle status, guest messages awaiting you, then your queued messages.
  const timelineFooter =
    pendingHandoff === null &&
    !hasThreadNow &&
    threadStatusLine === null &&
    pendingGuestMessageCount === 0 &&
    !hasQueuedTurns ? null : (
      <>
        {pendingHandoff === null ? null : (
          <div className="chat-content-lane">
            <HandoffRow
              environmentId={environmentId}
              endpoints={pendingHandoff}
              providers={providerStatuses}
              pending
            />
          </div>
        )}
        <ThreadNow
          key={routeThreadKey}
          attention={attentionNow}
          work={workNow}
          syncPhase={shownThreadSyncPhase}
          goal={goalNow}
        />
        {threadStatusLine}
        {pendingGuestMessageCount > 0 && isServerThread && activeThread ? (
          <GuestPendingMessages
            threadRef={scopeThreadRef(activeThread.environmentId, activeThread.id)}
            onImageExpand={onExpandTimelineImageStable}
            onFileOpen={openFileAttachmentStable}
          />
        ) : null}
        {hasQueuedTurns ? queuedRunsControl : null}
      </>
    );

  const pendingSidebarFileDrops = useSidebarPendingFileDropStore((state) => state.pending);
  const consumePendingFileDrop = useSidebarPendingFileDropStore(
    (state) => state.consumePendingFileDrop,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands pending sidebar file drops to the composer's imperative API once it mounts
  useEffect(() => {
    if (pendingSidebarFileDrops.length === 0) return;
    if (
      typeof composerDraftTarget === "string" ||
      !pendingSidebarFileDrops.some((drop) =>
        isSameSidebarThreadRef(composerDraftTarget, drop.threadRef),
      )
    ) {
      return;
    }
    if (!activeThread) return;
    if (!composerRef.current) {
      const raf = window.requestAnimationFrame(() => {
        if (!composerRef.current || typeof composerDraftTarget === "string") return;
        const files = consumePendingFileDrop(composerDraftTarget);
        if (files !== null) composerRef.current?.addDroppedFiles(files);
      });
      return () => window.cancelAnimationFrame(raf);
    }
    const files = consumePendingFileDrop(composerDraftTarget);
    if (files !== null) composerRef.current.addDroppedFiles(files);
  }, [
    activeThread,
    composerDraftTarget,
    composerRef,
    consumePendingFileDrop,
    pendingSidebarFileDrops,
  ]);

  const addDroppedFilesToComposer = useStableCallback(
    (files: Parameters<ChatComposerHandle["addDroppedFiles"]>[0]) =>
      composerRef.current?.addDroppedFiles(files),
  );
  const addDroppedFoldersToComposer = useStableCallback(
    (folders: Parameters<ChatComposerHandle["addDroppedFolders"]>[0]) =>
      composerRef.current?.addDroppedFolders(folders),
  );
  // Above the early return, where React Compiler can cache it for the side chat pane.
  const sideChatParentPanel = {
    openToolDiff: onOpenToolDiffStable,
    runShellCommand: runSideChatShellCommandStable,
  };

  return {
    ...prev, sideChatDisabledReason, openSideChatStable, sendSideChatStable, onConfirmRevertStable, onForkFromRunStable,
    onRevertTimelineTurnStable, onCompactContext, onResume, isResuming, onImplementPlanInNewThread, onSend,
    onImplementPlanInNewThreadStable, onWorktreeSetupWorkLocally, onWorktreeSetupWorkLocallyStable, onComposerSendStable, sendPreviewAnnotation, sendPreviewAnnotationStable,
    onComposerResumeStable, onComposerCompactContextStable, pendingGuestMessageIds, pendingGuestMessageCount, pendingGuestMessageKey, previousPendingGuestMessagesRef,
    queuedRunsControl, resendAfterWorkLocally, resendAfterWorkLocallyStable, workLocallyResendReady, onExpandTimelineImage, onExpandTimelineImageStable,
    shownThreadSyncPhase, hasThreadNow, queuedRunCount, hasQueuedTurns, scrollToEndSummary, timelineFooter,
    pendingSidebarFileDrops, consumePendingFileDrop, addDroppedFilesToComposer, addDroppedFoldersToComposer, sideChatParentPanel,
  };
}
