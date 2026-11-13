import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { EMPTY_PROVIDER_SKILLS, EMPTY_TURN_ITEMS } from "./chatViewTypes";
import { usePasteToFocusComposer } from "../chat/usePasteToFocusComposer";
import { useComposerSelection } from "../chat/useComposerSelection";
import { useThreadLifecycle } from "../chat/useThreadLifecycle";
import { useRightPanelActions } from "../chat/useRightPanelActions";
import { closeThreadFind, openThreadFind, useThreadFindOpen } from "../chat/threadFindStore";
import { usageLimitRecoveryBannerItem } from "../chat/UsageLimitRecoveryBanner";
import { useStableCallback } from "../../hooks/useStableCallback";
import { feedbackBannerItem } from "../chat/ComposerFeedback";
import { useChatShortcuts } from "../chat/useChatShortcuts";
import {
  ProviderInstanceId,
  type ScopedThreadRef,
  resolveIdleCompaction,
} from "@t3tools/contracts";
import { resolvePendingHandoff } from "@t3tools/client-runtime/handoff";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useEffect, useState } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../../env";
import { composerRequiresModifier } from "../../composer-logic";
import { copyThreadReference } from "../../lib/copyThreadReference";
import { useRightPanelStore } from "../../rightPanelStore";
import { threadPullRequestPanelTarget } from "../pullRequest/pullRequestDetail.logic";
import { isEditableFocused } from "../../lib/editableFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { projectScriptIdFromCommand } from "~/projectScripts";
import { isInSideChatPane } from "~/lib/sideChatPane";
import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";
import { isPreviewFocused } from "../../lib/previewFocus";
import { focusTerminalOnThreadEnter, getTerminalFocusOwner } from "../../lib/terminalFocus";
import { resolveProviderSkillsForCwd } from "@t3tools/client-runtime/providerSkills";
import { openBranchRestoreConfirm } from "../chat/ChatOverlayHosts";
import { useSideChat } from "../chat/useSideChat";
import { type ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { modelFallbackBannerItem } from "../chat/ComposerUsageLimits";
import { shouldOfferResumeCompaction } from "../chat/ContextWindowMeter.logic";
import { dismissBranchMismatchForSession } from "../ChatView.logic";
import { branchMismatchBannerItem } from "../chat/ThreadActivityBanners";
import { useChatViewPanelActions } from "./useChatViewPanelActions";

/** Composer compaction, banners, side chat, and prompt actions. */
export function useChatViewComposerState(prev: ReturnType<typeof useChatViewPanelActions>) {
  const {
  activeContextWindow, activeEnvironmentUnavailable, activeLatestRun, activePendingApproval,
  activePendingUserInput, activePreviewState, activeProject, activeProjectCwd,
  activeProjectScripts, activeProjectSettings, activeProviderInstanceId, activeProviderStatus,
  activeRightPanelSurface, activeRuntime, activeThread, activeThreadId,
  activeThreadKey, activeThreadLiveTokenUsage, activeThreadRef, activeThreadReferenceCopyTarget,
  activeThreadShell, activeThreadWorktreePath, backgroundThread, beginLocalDispatch,
  branchToolbarRef, browserAvailable, canChangeEnvironment, canInterruptRunningThread,
  canMaximizeRightPanel, canOperatePreview, canOperateTerminal, canOperateThread,
  canOverrideServerThreadEnvMode, canWriteSourceControl, clearUsageLimitsFor, clientSettingsHydrated,
  closeRightPanelSurface, composerDraftTarget, composerModelSelectionExplicit, composerOverlayElement,
  composerRef, composerSelectedModelSelection, currentRouteThreadKeyRef, delegatedFrom,
  deviceState, deviceStateLoaded, diffOpen, dismissedFallbackWindow,
  draftDefaultModelSelection, draftFallback, draftThread, embedded,
  environmentId, explicitDiffOpenRef, feedbackSubmissions, feedbackUploading,
  focusComposerStable, gitCwd, gitStatusQuery, hasHeldQueuedRuns,
  interactionMode, interactionModeEnabled, isGitRepo, isLocalDraftThread,
  isPreparingWorktree, isRevertingCheckpoint, isServerThread, isWorking,
  keybindings, linkedThreadPullRequest, localCheckoutBranchMismatch, lockedProvider,
  logicalProjectEnvironments, manualCompactionProviderAvailable, multipleModelSelections, nativeResumeCompactionDismissed,
  nowMinute, onDiffPanelOpen, onEnvironmentChangeStable, onInterruptStable,
  pendingApprovals, pendingBackgroundTasks, pendingUserInputs, persistThreadSettingsForNextTurn,
  phase, previewPanelOpen, projectCloneBannerItem, promptRef,
  providerInstanceEntries, providerStatuses, pullRequestsSurfaceAvailable, queuedRunsControlRef,
  readPendingEnvironmentChange, resetLocalDispatch, resumeCompactionPermanentlyDismissed, rightPanelMaximized,
  rightPanelOpen, routeKind, routeThreadDetailRef, routeThreadKey,
  runProjectScriptStable, runShellCommandStable, runtimeMode, scheduleComposerFocus,
  scriptKeybindings, scrollToEnd, selectedProvider, sendInFlightRef,
  serverConfig, serverProjection, serverRuntime, serverVisibleTurnItems,
  setDismissedFallbackWindow, setFeedbackSubmissionsByThreadKey, setOptimisticUserMessages, setPendingServerThreadEnvModeEntry,
  setPendingServerThreadStartFromOriginByThreadId, setTerminalUiLaunchContext, setThreadError, settings,
  showPlanFollowUpPrompt, supportsProviderSwitchingViaHandoff, supportsPullRequests, systemComposerBannerItems,
  terminalShortcuts, terminalUiLaunchContext, terminalUiState, threadDetailLoading,
  threadPanelPresentation, timestampFormat, updateThreadMetadata, usageLimitsBanner,
  visiblePullRequests,
  } = prev;
  const copyActiveThreadReference = () => {
    if (activeThreadReferenceCopyTarget === null) return;
    void copyThreadReference(activeThreadReferenceCopyTarget);
  };
  const pullRequestPanelTarget = activeThread
    ? threadPullRequestPanelTarget({
        projectId: activeThread.projectId,
        pullRequests: visiblePullRequests,
        linkedPullRequest: linkedThreadPullRequest,
        branchPullRequest: activeThreadShell?.branchPullRequest ?? activeThread.branchPullRequest,
      })
    : null;
  const {
    activateRightPanelSurfaceStable,
    addDeviceSurfaceStable,
    addDiffSurfaceStable,
    addFilesSurfaceStable,
    addPullRequestSurfaceStable,
    addPullRequestsSurfaceStable,
    closePreviewPanelStable,
    copyRightPanelFilePathStable,
    createBrowserSurface,
    createBrowserSurfaceStable,
    moveRightPanelSurfaceStable,
    onOpenToolDiffStable,
    onOpenTurnDiffStable,
    openChangesFromThreadPanelStable,
    openFileSurfaceStable,
    toggleRightPanelMaximizedStable,
    toggleRightPanelStable,
    toggleThreadPanelStable,
    shortcuts: rightPanelShortcuts,
  } = useRightPanelActions({
    activeThreadRef,
    activeProject,
    activeRightPanelSurface,
    activePreviewState,
    deviceState,
    deviceStateLoaded,
    pullRequestPanelTarget,
    threadPanelPresentation,
    isServerThread,
    embedded,
    isGitRepo,
    browserAvailable,
    canOperatePreview,
    diffOpen,
    previewPanelOpen,
    rightPanelOpen,
    canMaximizeRightPanel,
    rightPanelMaximized,
    supportsPullRequests,
    pullRequestsSurfaceAvailable,
    gitCwd,
    activeProjectCwd,
    explicitDiffOpenRef,
    onDiffPanelOpen,
    closeRightPanelSurface,
  });
  const pullRequestSurfaceAvailable = supportsPullRequests && pullRequestPanelTarget !== null;
  const {
    acknowledgeActiveThreadWoke,
    activeBranchMismatchKey,
    attentionNow,
    workNow,
    childInputNow,
    goalNow,
    handleSwitchCheckoutToThread,
    handleSwitchCheckoutToThreadStable,
    isRestoringThreadBranch,
    onOpenRelatedThreadStable,
    sendStandaloneCommand,
    setBranchMismatchDismissTick,
    showBranchMismatchBanner,
    threadStatusLine,
    shortcuts: threadLifecycleShortcuts,
  } = useThreadLifecycle({
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    canOperateThread,
    clientSettingsHydrated,
    activeThread,
    activeThreadId,
    activeThreadRef,
    threadDetailRef: routeThreadDetailRef,
    activeThreadKey,
    activeThreadShell,
    activeLatestRun,
    activeProjectCwd,
    serverConfig,
    runtimeMode,
    isWorking,
    pendingBackgroundTasks,
    turnItems: serverProjection?.turnItems ?? EMPTY_TURN_ITEMS,
    activePendingApproval,
    activePendingUserInput,
    localCheckoutBranchMismatch,
    gitStatusQuery,
    nowMinute,
    composerRef,
    composerDraftTarget,
    sendInFlightRef,
    setOptimisticUserMessages,
    setThreadError,
    clearUsageLimitsFor,
    beginLocalDispatch,
    resetLocalDispatch,
    scrollToEnd,
    persistThreadSettingsForNextTurn,
  });
  const activeThreadHasCompactableConversation = serverVisibleTurnItems.some(
    ({ item }) =>
      item.type === "user_message" &&
      (item.text.trim().toLowerCase() !== "/compact" || item.attachments.length > 0),
  );
  const pendingHandoffSelection = composerSelectedModelSelection ?? activeThread?.modelSelection;
  const pendingHandoffSelectionUsable = providerInstanceEntries.some(
    (entry) =>
      entry.instanceId === pendingHandoffSelection?.instanceId &&
      entry.enabled &&
      entry.isAvailable,
  );
  const pendingHandoff = resolvePendingHandoff(
    serverProjection,
    pendingHandoffSelectionUsable ? pendingHandoffSelection : null,
    providerStatuses,
  );
  const compactThreadUnavailable =
    !canOperateThread ||
    !activeThread ||
    !activeThreadHasCompactableConversation ||
    !activeProject ||
    !isServerThread ||
    !manualCompactionProviderAvailable ||
    isWorking ||
    isRevertingCheckpoint ||
    threadDetailLoading ||
    isPreparingWorktree ||
    activeEnvironmentUnavailable ||
    feedbackUploading ||
    pendingApprovals.length > 0 ||
    pendingUserInputs.length > 0 ||
    showPlanFollowUpPrompt;
  const compactDisabled = compactThreadUnavailable;
  const compactDisabledReason = compactDisabled
    ? !canOperateThread
      ? "This connection cannot change threads."
      : !activeProject
        ? "Choose a project before compacting"
        : !manualCompactionProviderAvailable
          ? "Compaction is unavailable for this provider"
          : "Compacting is unavailable right now"
    : null;
  const resumeCompactionTokens =
    activeContextWindow &&
    resolveIdleCompaction(
      settings,
      activeProviderInstanceId ?? ProviderInstanceId.make("claudeAgent"),
    ) !== "off" &&
    !resumeCompactionPermanentlyDismissed &&
    !nativeResumeCompactionDismissed &&
    !compactDisabled &&
    !hasHeldQueuedRuns &&
    multipleModelSelections === null &&
    shouldOfferResumeCompaction({
      provider: selectedProvider,
      usedTokens: activeContextWindow.usedTokens,
      updatedAt: activeContextWindow.updatedAt,
      promptCacheTtlMs: activeThreadLiveTokenUsage?.promptCacheTtlMs,
      now: `${nowMinute}:00.000Z`,
    })
      ? activeContextWindow.usedTokens
      : null;
  const [fullHistoryThreadKeys, setFullHistoryThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const keepFullHistory = fullHistoryThreadKeys.has(routeThreadKey);
  const setKeepFullHistory = (threadKey: string, keep: boolean) => {
    setFullHistoryThreadKeys((current) => {
      if (current.has(threadKey) === keep) return current;
      const next = new Set(current);
      if (keep) next.add(threadKey);
      else next.delete(threadKey);
      return next;
    });
  };
  const toggleKeepFullHistory = () => setKeepFullHistory(routeThreadKey, !keepFullHistory);
  const toggleKeepFullHistoryStable = useStableCallback(toggleKeepFullHistory);
  const handleRestoreThreadBranch = () => {
    if (!canWriteSourceControl) return;
    if (gitStatusQuery.data?.hasWorkingTreeChanges) {
      if (activeThreadKey !== null) openBranchRestoreConfirm(activeThreadKey);
      return;
    }
    void handleSwitchCheckoutToThread();
  };
  const handleRestoreThreadBranchStable = useStableCallback(handleRestoreThreadBranch);
  const feedbackBannerItems = feedbackSubmissions.flatMap((submission) => {
    const item = feedbackBannerItem(submission, () => {
      setFeedbackSubmissionsByThreadKey((current) => ({
        ...current,
        [routeThreadKey]: (current[routeThreadKey] ?? []).filter(
          (entry) => entry.id !== submission.id,
        ),
      }));
    });
    return item ? [item] : [];
  });
  const limitRecoveryBanner =
    serverRuntime?.status === "failed" &&
    serverRuntime.lastErrorClass === "usage_limit" &&
    activeThreadShell?.latestRun
      ? usageLimitRecoveryBannerItem({
          runId: activeThreadShell.latestRun.runId,
          resetAt: serverRuntime.usageLimitResetAt ?? null,
          stoppedAt: activeThreadShell.latestRun.completedAt ?? activeThreadShell.updatedAt,
          recovery: activeThreadShell.limitRecovery ?? null,
          snoozedUntil: activeThreadShell.snoozedUntil,
          timestampFormat,
          onChange: async (limitRecovery) => {
            const result = await updateThreadMetadata({
              environmentId,
              input: { threadId: activeThreadShell.id, limitRecovery },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          },
        })
      : null;
  const {
    getModelDisabledReason,
    handleInteractionModeChange,
    handleInteractionModeChangeStable,
    handleRuntimeModeChangeStable,
    onEnvModeChangeStable,
    onProviderModelSelectStable,
    onStartFromOriginChange,
    openProviderSetupStable,
    toggleInteractionModeStable,
  } = useComposerSelection({
    environmentId,
    composerDraftTarget,
    draftThread,
    activeThread,
    activeRuntime,
    activeProjectSettings,
    settings,
    providerStatuses,
    lockedProvider,
    supportsProviderSwitchingViaHandoff,
    multipleModelSelections,
    runtimeMode,
    interactionMode,
    interactionModeEnabled,
    isLocalDraftThread,
    canOverrideServerThreadEnvMode,
    setPendingServerThreadEnvModeEntry,
    setPendingServerThreadStartFromOriginByThreadId,
    scheduleComposerFocus,
  });

  const composerBannerItems = (() => {
    const fallbackSelection = draftFallback?.selection;
    const defaultSelection =
      draftDefaultModelSelection ??
      resolveProjectDefaultProviderModelSelection(
        providerStatuses,
        settings,
        draftThread?.projectId ?? null,
      );
    const fallback =
      !isServerThread &&
      multipleModelSelections === null &&
      !composerModelSelectionExplicit &&
      draftFallback?.fallback &&
      (!composerSelectedModelSelection ||
        (composerSelectedModelSelection.instanceId === fallbackSelection?.instanceId &&
          composerSelectedModelSelection.model === fallbackSelection?.model))
        ? draftFallback.fallback
        : null;
    const fallbackWindow = fallback
      ? `${fallback.provider.instanceId}:${fallback.resetsAt ?? ""}`
      : null;
    const fallbackItems: ComposerBannerStackItem[] =
      fallback &&
      fallbackSelection &&
      defaultSelection &&
      fallbackWindow !== dismissedFallbackWindow
        ? [
            modelFallbackBannerItem({
              fallbackModelName:
                providerStatuses
                  .find((provider) => provider.instanceId === fallbackSelection.instanceId)
                  ?.models.find((model) => model.slug === fallbackSelection.model)?.name ??
                fallbackSelection.model,
              defaultProviderName: fallback.provider.displayName ?? fallback.provider.driver,
              defaultModelName:
                fallback.provider.models.find((model) => model.slug === defaultSelection.model)
                  ?.name ?? defaultSelection.model,
              resetsAt: fallback.resetsAt,
              timestampFormat,
              onUseDefault: () =>
                onProviderModelSelectStable(defaultSelection.instanceId, defaultSelection.model),
              onDismiss: () => setDismissedFallbackWindow(fallbackWindow),
            }),
          ]
        : [];
    const limitRecoveryItems = limitRecoveryBanner === null ? [] : [limitRecoveryBanner];
    const usageLimitsItems = usageLimitsBanner === null ? [] : [usageLimitsBanner];
    const projectCloneItems = projectCloneBannerItem === null ? [] : [projectCloneBannerItem];
    if (!localCheckoutBranchMismatch || !showBranchMismatchBanner || !activeBranchMismatchKey) {
      return [
        ...feedbackBannerItems,
        ...fallbackItems,
        ...limitRecoveryItems,
        ...usageLimitsItems,
        ...projectCloneItems,
        ...systemComposerBannerItems,
      ];
    }
    return [
      ...feedbackBannerItems,
      ...fallbackItems,
      ...limitRecoveryItems,
      ...usageLimitsItems,
      ...projectCloneItems,
      ...systemComposerBannerItems,
      branchMismatchBannerItem({
        mismatchKey: activeBranchMismatchKey,
        mismatch: localCheckoutBranchMismatch,
        restoreDisabled: !canWriteSourceControl || isRestoringThreadBranch,
        restoring: isRestoringThreadBranch,
        onRestore: handleRestoreThreadBranchStable,
        onDismiss: () => {
          dismissBranchMismatchForSession(activeBranchMismatchKey);
          setBranchMismatchDismissTick((tick) => tick + 1);
        },
      }),
    ];
  })() as ComposerBannerStackItem[];

  if (
    terminalUiLaunchContext !== null &&
    (terminalUiLaunchContext.threadId !== activeThreadId ||
      !terminalUiState.terminalOpen ||
      (activeProjectCwd !== null &&
        projectScriptCwd({
          project: { cwd: activeProjectCwd },
          worktreePath: activeThreadWorktreePath,
        }) === terminalUiLaunchContext.cwd &&
        (activeThreadWorktreePath ?? null) === terminalUiLaunchContext.worktreePath))
  ) {
    setTerminalUiLaunchContext(null);
  }

  // Entering a thread with its drawer open focuses the drawer terminal; opening
  // it from a handler requests focus there. A closed drawer leaves focus to the
  // composer effect above.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the open drawer terminal when entering a thread
  useEffect(() => {
    if (activeThreadRef && !embedded) return focusTerminalOnThreadEnter(activeThreadRef);
  }, [activeThreadRef, embedded]);

  const getShortcutContext = (eventTarget: EventTarget | null = document.activeElement) => ({
    terminalFocus: getTerminalFocusOwner() !== null,
    terminalOpen: Boolean(terminalUiState.terminalOpen),
    previewFocus: isPreviewFocused(),
    previewOpen: previewPanelOpen,
    editableFocus: isEditableFocused(eventTarget),
    modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
    composerFocus:
      document.activeElement?.getAttribute("data-testid") === "composer-editor" &&
      isInSideChatPane(document.activeElement) === embedded,
    draftThreadRoute: routeKind === "draft",
    turnRunning: phase === "running",
    composerRequiresModifier: composerRequiresModifier(settings.sendShortcut, promptRef.current),
    isWeb: !isElectron,
    isDesktop: isElectron,
  });
  const getShortcutContextStable = useStableCallback(getShortcutContext);
  const timelineSkills = activeProviderStatus
    ? resolveProviderSkillsForCwd(activeProviderStatus, gitCwd)
    : EMPTY_PROVIDER_SKILLS;
  const threadFindEnabled = isServerThread && serverConfig?.threadFind === true;
  const isThreadFindActive = useThreadFindOpen(activeThreadRef, threadFindEnabled);
  const openThreadFindStable = useStableCallback((threadRef: ScopedThreadRef) => {
    if (threadFindEnabled && scopedThreadKey(threadRef) === activeThreadKey) {
      openThreadFind(activeThreadKey);
    }
  });

  useChatShortcuts({
    enabled: activeThreadId !== null && !backgroundThread,
    embedded,
    composerElement: composerOverlayElement,
    keybindings,
    scriptKeybindings,
    getShortcutContext,
    threadFindActive: isThreadFindActive,
    composerRef,
    branchToolbarRef,
    closeThreadFind: () => {
      closeThreadFind();
      focusComposerStable();
    },
    commands: {
      ...terminalShortcuts,
      ...rightPanelShortcuts,
      ...threadLifecycleShortcuts,
      "thread.copyReference": ({ event }) => {
        if (!event.repeat) copyActiveThreadReference();
      },
      "chat.find": () => {
        if (!isServerThread || serverConfig?.threadFind !== true || activeThreadKey === null)
          return false;
        openThreadFind(activeThreadKey);
      },
      "composer.cycleHost": ({ event }) => {
        if (!canChangeEnvironment) return false;
        if (event.repeat) return;
        const currentId = readPendingEnvironmentChange()?.environmentId ?? environmentId;
        const index = logicalProjectEnvironments.findIndex(
          (env) => env.environmentId === currentId,
        );
        const next = logicalProjectEnvironments[(index + 1) % logicalProjectEnvironments.length];
        if (next) onEnvironmentChangeStable(next.environmentId);
      },
      "thread.steerQueuedMessage": ({ event }) =>
        routeKind !== "draft" && queuedRunsControlRef.current?.steerNext(event.repeat) === true,
      "thread.editQueuedMessage": ({ event }) =>
        routeKind !== "draft" &&
        composerRef.current?.isCaretAtStart() === true &&
        queuedRunsControlRef.current?.editLatest(event.repeat) === true,
      "thread.stop": ({ event }) => {
        if (!canInterruptRunningThread) return false;
        if (!event.repeat) void onInterruptStable();
      },
    },
    fallback: (command) => {
      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject || !canOperateTerminal) return undefined;
      const script = activeProjectScripts.find((entry) => entry.id === scriptId);
      return script ? () => void runProjectScriptStable(script) : undefined;
    },
  });

  // A focused desktop browser page forwards these chords as menu actions.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to desktop bridge menu actions that toggle the right panel
  useEffect(() => {
    if (embedded) return;
    return window.desktopBridge?.onMenuAction((action) => {
      if (action === "rightPanel.toggle") toggleRightPanelStable();
      else if (action === "rightPanel.toggleMaximized") toggleRightPanelMaximizedStable();
    });
  }, [embedded, toggleRightPanelStable, toggleRightPanelMaximizedStable]);

  usePasteToFocusComposer(embedded ? null : activeThreadId, composerRef);
  // A delegated task is a remote thread's subagent.
  const isSubagentThread =
    activeThread?.lineage.relationshipToParent === "subagent" || delegatedFrom !== null;
  // Side chats do not nest or start from subagents, and older servers would fork a listed thread.
  const sideChatsOffered =
    !embedded &&
    canOperateThread &&
    activeThread?.lineage.sideChat !== true &&
    !isSubagentThread &&
    serverConfig?.environment.capabilities.sideChats === true;
  const sideChat = useSideChat({
    threadRef: sideChatsOffered && isServerThread ? activeThreadRef : null,
    onError: (message) => {
      if (activeThread) setThreadError(activeThread.id, message);
    },
  });
  // A maximized panel covers the terminal drawer the command runs in.
  const runSideChatShellCommandStable = useStableCallback((command: string) => {
    if (activeThreadRef) useRightPanelStore.getState().setMaximized(activeThreadRef, false);
    runShellCommandStable(command);
  });

  return {
    ...prev, copyActiveThreadReference, pullRequestPanelTarget, activateRightPanelSurfaceStable, addDeviceSurfaceStable, addDiffSurfaceStable,
    addFilesSurfaceStable, addPullRequestSurfaceStable, addPullRequestsSurfaceStable, closePreviewPanelStable, copyRightPanelFilePathStable, createBrowserSurface,
    createBrowserSurfaceStable, moveRightPanelSurfaceStable, onOpenToolDiffStable, onOpenTurnDiffStable, openChangesFromThreadPanelStable, openFileSurfaceStable,
    toggleRightPanelMaximizedStable, toggleRightPanelStable, toggleThreadPanelStable, rightPanelShortcuts, pullRequestSurfaceAvailable, acknowledgeActiveThreadWoke,
    activeBranchMismatchKey, attentionNow, workNow, childInputNow, goalNow, handleSwitchCheckoutToThread,
    handleSwitchCheckoutToThreadStable, isRestoringThreadBranch, onOpenRelatedThreadStable, sendStandaloneCommand, setBranchMismatchDismissTick, showBranchMismatchBanner,
    threadStatusLine, threadLifecycleShortcuts, activeThreadHasCompactableConversation, pendingHandoffSelection, pendingHandoffSelectionUsable, pendingHandoff,
    compactThreadUnavailable, compactDisabled, compactDisabledReason, resumeCompactionTokens, fullHistoryThreadKeys, setFullHistoryThreadKeys,
    keepFullHistory, setKeepFullHistory, toggleKeepFullHistory, toggleKeepFullHistoryStable, handleRestoreThreadBranch, handleRestoreThreadBranchStable,
    feedbackBannerItems, limitRecoveryBanner, getModelDisabledReason, handleInteractionModeChange, handleInteractionModeChangeStable, handleRuntimeModeChangeStable,
    onEnvModeChangeStable, onProviderModelSelectStable, onStartFromOriginChange, openProviderSetupStable, toggleInteractionModeStable, composerBannerItems,
    getShortcutContext, getShortcutContextStable, timelineSkills, threadFindEnabled, isThreadFindActive, openThreadFindStable,
    isSubagentThread, sideChatsOffered, sideChat, runSideChatShellCommandStable,
  };
}
