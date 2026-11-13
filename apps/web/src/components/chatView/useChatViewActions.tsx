import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { CodexArtifactTemplate } from "@t3tools/shared/codexArtifactTemplates";
import { DismissedFallbackWindowSchema, EMPTY_PROVIDER_MODELS } from "./chatViewTypes";
import { useChatTerminalActions } from "../chat/useChatTerminalActions";
import {
  recallCheckoutIsRepo,
  rememberCheckoutIsRepo,
  codexArtifactTemplatePromptToAppend,
} from "../ChatView.logic";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useProjectScriptEditing } from "../chat/useProjectScriptEditing";
import { AuthOrchestrationOperateScope, AuthPreviewOperateScope } from "@t3tools/contracts";
import { formatModelSelectionEffort } from "@t3tools/client-runtime/state/thread-execution";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { use, useEffect, useRef, useState } from "react";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { deriveCanInterruptRunningThread } from "../../session-logic";
import { useWorkspaceMutationRefresh } from "../../hooks/useWorkspaceMutationRefresh";
import { subscribeSnapShotComposerFocus } from "../../lib/desktopSnapShot";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { shortcutLabelForCommand } from "../../keybindings";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { toastManager } from "../ui/toast";
import { newMessageId } from "~/lib/utils";
import { useEnvironmentScope } from "~/state/session";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  serverEnvironment,
} from "../../state/server";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { useRemoteOpenState } from "~/remoteOpen";
import { shouldShowOpenInPicker } from "../chat/OpenInPicker.logic";
import { useOpenFavoriteEditorShortcut } from "../chat/OpenInPickerShortcut";
import { shouldShowComposerContextStrip } from "../BranchToolbar.logic";
import {
  getProviderStatusBannerKey,
  shouldShowProviderStatusBanner,
} from "../chat/ProviderStatusBanner";
import { type QueuedRunsControlHandle } from "../chat/QueuedRunsControl";
import {
  hasAvailableCompactionProvider,
  hasDismissedResumeCompaction,
} from "../chat/ContextWindowMeter.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { readEnvironmentScope } from "../../state/session";
import { useDraftEnvironmentRouting } from "../chat/useDraftEnvironmentRouting";
import { useChatViewPanelsState } from "./useChatViewPanelsState";
import * as Schema from "effect/Schema";

/** Shortcuts, focus handling, and composer focus helpers. */
export function useChatViewActions(prev: ReturnType<typeof useChatViewPanelsState>) {
  const {
  activePreviewMiniPlayer, activeProject, activeProjectIsScratch, activeProjectKey,
  activeProjectScripts, activeProviderInstanceId, activeProviderStatus, activeRightPanelSurface,
  activeRuntime, activeServerOrderedTerminalIds, activeTerminalLabelsById, activeThread,
  activeThreadId, activeThreadKey, activeThreadRef, automaticEnvironment,
  canOperateThread, canReuseTerminal, composerHasAttachments, composerRef,
  draftId, draftThread, embedded, envLocked,
  environmentById, environmentId, gitCwd, gitStatusCwd,
  gitStatusQuery, interactionMode, interruptThreadTurn, isDraftHeroState,
  isProviderSubagent, isServerThread, loadBalancingSettings, lockedProvider,
  logicalProjectEnvironments, panelTerminalIds, previewMiniPlayerVisible, primaryEnvironmentId,
  projectGroupingSettings, providerInstanceEntries, providersByEnvironment, referencedThreadContexts,
  reportedModelSelection, runningTerminalIds, runtimeMode, selectedProvider,
  selectedProviderEntry, sendInFlightRef, serverProjection, setTerminalUiLaunchContext,
  setThreadError, settings, showComposerEnvironmentIndicator, startThreadTurn,
  terminalUiLaunchContext, terminalUiState, timelineThreadError, workspaceMutationId,
  } = prev;
  useWorkspaceMutationRefresh({
    enabled: gitStatusCwd !== null,
    mutationId: workspaceMutationId,
    refresh: gitStatusQuery.refresh,
    resourceKey: `git-status:${activeThreadKey ?? ""}:${gitStatusCwd ?? ""}`,
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const backgroundThread = use(BackgroundThreadContext);
  const scriptKeybindings =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.keybindings ??
    DEFAULT_RESOLVED_KEYBINDINGS;
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const remoteOpenState = useRemoteOpenState(activeThread?.environmentId ?? environmentId);
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName: activeProject?.title,
    activeThreadEnvironmentId: activeThread?.environmentId ?? environmentId,
    primaryEnvironmentId,
    remoteOpenMode: remoteOpenState.mode,
  });
  useOpenFavoriteEditorShortcut({
    enabled: showOpenInPicker && !backgroundThread,
    environmentId: activeThread?.environmentId ?? environmentId,
    keybindings,
    availableEditors,
    openInCwd: gitCwd,
  });
  const manualCompactionProviderAvailable = hasAvailableCompactionProvider({
    providers: providerInstanceEntries,
    driverKind: selectedProvider,
    instanceId: activeProviderInstanceId,
    lockedInstanceId: lockedProvider
      ? (activeRuntime?.providerInstanceId ?? activeThread?.modelSelection.instanceId ?? null)
      : null,
  });
  const [resumeCompactionPermanentlyDismissed, setResumeCompactionPermanentlyDismissed] =
    useLocalStorage(
      `t3code:resume-compaction-dismissed:${environmentId}:${activeProviderInstanceId ?? "claudeAgent"}`,
      false,
      Schema.Boolean,
    );
  const nativeResumeCompactionDismissed = hasDismissedResumeCompaction(
    (serverProjection?.runtimeRequests ?? [])
      .filter((request) => request.kind === "user_input" && request.status === "resolved")
      .map((request) => ({
        kind: "user-input.resolved",
        payload: { answers: request.answers },
      })),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists the server-reported resume compaction dismissal to localStorage
  useEffect(() => {
    if (nativeResumeCompactionDismissed && !resumeCompactionPermanentlyDismissed) {
      setResumeCompactionPermanentlyDismissed(true);
    }
  }, [
    nativeResumeCompactionDismissed,
    resumeCompactionPermanentlyDismissed,
    setResumeCompactionPermanentlyDismissed,
  ]);
  const [dismissedFallbackWindow, setDismissedFallbackWindow] = useLocalStorage(
    `t3code:fallback-notice-dismissed:${environmentId}`,
    null,
    DismissedFallbackWindowSchema,
  );
  const providerStatusBannerKey = getProviderStatusBannerKey(activeProviderStatus);
  const [dismissedProviderStatusBannerKey, setDismissedProviderStatusBannerKey] = useState<
    string | null
  >(null);
  if (providerStatusBannerKey === null && dismissedProviderStatusBannerKey !== null) {
    setDismissedProviderStatusBannerKey(null);
  }
  const visibleProviderStatus = shouldShowProviderStatusBanner(
    activeProviderStatus,
    dismissedProviderStatusBannerKey,
  )
    ? activeProviderStatus
    : null;
  const hasTimelineTopBanner = Boolean(timelineThreadError) || visibleProviderStatus !== null;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeWorkspaceRoot = activeThreadWorktreePath ?? activeProjectCwd ?? undefined;
  const activeTerminalLaunchContext =
    terminalUiLaunchContext?.threadId === activeThreadId ? terminalUiLaunchContext : null;
  const liveIsGitRepo = gitStatusQuery.data?.isRepo;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records live git repo status in the session cache read while the status query is unavailable
  useEffect(() => {
    if (gitStatusCwd !== null && liveIsGitRepo !== undefined) {
      rememberCheckoutIsRepo(environmentId, gitStatusCwd, liveIsGitRepo);
    }
  }, [environmentId, gitStatusCwd, liveIsGitRepo]);
  const isGitRepo = liveIsGitRepo ?? recallCheckoutIsRepo(environmentId, gitStatusCwd) ?? true;
  // Provider-native subagents cannot take messages; approvals and questions go to the top-level parent.
  const showProviderSubagentBar = isProviderSubagent;
  const composerMounted = !showProviderSubagentBar;
  const providerSubagentModels = selectedProviderEntry?.models ?? EMPTY_PROVIDER_MODELS;
  // Providers can report dated model ids or aliases.
  const providerSubagentModelSlug = selectedProviderEntry
    ? resolveSelectableModel(
        selectedProviderEntry.driverKind,
        activeThread?.modelSelection.model,
        providerSubagentModels,
      )
    : null;
  const providerSubagentCatalogModel = providerSubagentModels.find(
    (model) => model.slug === providerSubagentModelSlug,
  );
  const providerSubagentModelLabel = providerSubagentCatalogModel
    ? getTriggerDisplayModelName(providerSubagentCatalogModel, selectedProviderEntry?.driverKind)
    : formatModelSlugName(activeThread?.modelSelection.model ?? "");
  const providerSubagentEffortLabel =
    activeThread === undefined
      ? null
      : formatModelSelectionEffort(
          activeThread.modelSelection,
          providerSubagentModels,
          reportedModelSelection,
        );
  const showComposerContextStrip =
    !embedded &&
    shouldShowComposerContextStrip({
      isDraftHeroState,
      persistInActiveThreads: settings.persistComposerContextStrip,
      hasActiveProject: activeProject !== null && !showProviderSubagentBar,
      isGitRepo,
      showEnvironmentIndicator: showComposerEnvironmentIndicator,
    });
  const terminalShortcutLabelOptions = {
    context: {
      terminalFocus: true,
      terminalOpen: Boolean(terminalUiState.terminalOpen),
    },
  };
  const splitTerminalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.split",
    terminalShortcutLabelOptions,
  );
  const splitTerminalVerticalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.splitVertical",
    terminalShortcutLabelOptions,
  );
  const newTerminalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.new",
    terminalShortcutLabelOptions,
  );
  const closeTerminalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.close",
    terminalShortcutLabelOptions,
  );

  const {
    needsLoadBalancing,
    loadBalancing,
    onAutoEnvironmentStable,
    autoEnvironmentLabel,
    isEnvironmentChanging,
    readPendingEnvironmentChange,
    onEnvironmentChangeStable,
  } = useDraftEnvironmentRouting({
    draftId,
    draftThread,
    envLocked,
    automaticEnvironment,
    logicalProjectEnvironments,
    environmentById,
    providersByEnvironment,
    loadBalancingSettings,
    referencedThreadContexts,
    activeProviderInstanceId,
    selectedProvider,
    composerHasAttachments,
    activeProjectKey,
    activeProjectIsScratch,
    projectGroupingSettings,
    sendInFlightRef,
  });

  const focusComposer = () => {
    composerRef.current?.focusAtEnd();
  };
  const focusComposerStable = useStableCallback(focusComposer);
  const canInterruptRunningThread =
    canOperateThread && deriveCanInterruptRunningThread(activeThread !== undefined, activeRuntime);
  const onInterrupt = async () => {
    if (
      !activeThread ||
      !readEnvironmentScope(activeThread.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const result = await interruptThreadTurn({
      environmentId,
      input: { threadId: activeThread.id },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to interrupt the current turn.",
      );
    }
  };
  const onInterruptStable = useStableCallback(onInterrupt);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window listener for the desktop snapshot event that focuses the composer
  useEffect(
    () => (embedded ? undefined : subscribeSnapShotComposerFocus(focusComposerStable)),
    [embedded, focusComposerStable],
  );
  const scheduleComposerFocus = () => {
    window.requestAnimationFrame(() => {
      // The model picker stays open through its own changes, so it keeps focus.
      if (!isModelPickerOpen()) focusComposer();
    });
  };
  const scheduleComposerFocusStable = useStableCallback(scheduleComposerFocus);
  const insertArtifactTemplate = (template: CodexArtifactTemplate) => {
    const composer = composerRef.current;
    if (!composer) return;

    const currentDraft = composer.getSendContext().prompt;
    const prompt = codexArtifactTemplatePromptToAppend(currentDraft, template);
    if (prompt !== null && !composer.insertTextAtEnd(prompt, { ensureLeadingBoundary: true })) {
      toastManager.add({
        type: "error",
        title: "Unable to add to chat",
        description: "The composer is busy; try again once it is ready.",
      });
      return;
    }
    scheduleComposerFocus();
  };
  const insertArtifactTemplateStable = useStableCallback(insertArtifactTemplate);
  const sendAppMessage = async (text: string) => {
    if (!isServerThread || activeThreadId === null) {
      throw new Error("Messages from apps need a started thread.");
    }
    const result = await startThreadTurn({
      environmentId,
      input: {
        threadId: activeThreadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        runtimeMode,
        interactionMode,
        dispatchMode: "queue",
      },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      throw error instanceof Error ? error : new Error("Could not send the app's message.");
    }
  };
  const sendAppMessageStable = useStableCallback(sendAppMessage);
  const queuedRunsControlRef = useRef<QueuedRunsControlHandle>(null);

  const {
    activatePanelTerminalStable,
    addTerminalContextToDraftStable,
    addTerminalSurfaceStable,
    closePanelTerminalStable,
    lastInvokedScriptByProjectId,
    runProjectScriptStable,
    runShellCommandStable,
    splitPanelTerminalStable,
    splitPanelTerminalVerticalStable,
    toggleTerminalVisibilityStable,
    shortcuts: terminalShortcuts,
  } = useChatTerminalActions({
    environmentId,
    composerRef,
    terminalUiState,
    activeThread,
    activeThreadId,
    activeThreadRef,
    activeProject,
    activeRightPanelSurface,
    runningTerminalIds,
    activeServerOrderedTerminalIds,
    activeTerminalLabelsById,
    panelTerminalIds,
    canReuseTerminal,
    gitCwd,
    setTerminalUiLaunchContext,
    setThreadError,
  });
  const {
    saveProjectScript: saveProjectScriptStable,
    updateProjectScript: updateProjectScriptStable,
    deleteProjectScript: deleteProjectScriptStable,
  } = useProjectScriptEditing({
    environmentId,
    project: activeProject,
    scripts: activeProjectScripts,
    settings,
  });
  const canOperatePreview = useEnvironmentScope(
    activeThreadRef?.environmentId ?? null,
    AuthPreviewOperateScope,
  );
  const shownPreviewMiniPlayer =
    activeThreadRef &&
    activePreviewMiniPlayer &&
    previewMiniPlayerVisible &&
    (activePreviewMiniPlayer.source.kind === "device" || canOperatePreview)
      ? activePreviewMiniPlayer
      : null;

  return {
    ...prev, keybindings, backgroundThread, scriptKeybindings, availableEditors, remoteOpenState,
    showOpenInPicker, manualCompactionProviderAvailable, resumeCompactionPermanentlyDismissed, setResumeCompactionPermanentlyDismissed, nativeResumeCompactionDismissed, dismissedFallbackWindow,
    setDismissedFallbackWindow, providerStatusBannerKey, dismissedProviderStatusBannerKey, setDismissedProviderStatusBannerKey, visibleProviderStatus, hasTimelineTopBanner,
    activeProjectCwd, activeThreadWorktreePath, activeWorkspaceRoot, activeTerminalLaunchContext, liveIsGitRepo, isGitRepo,
    showProviderSubagentBar, composerMounted, providerSubagentModels, providerSubagentModelSlug, providerSubagentCatalogModel, providerSubagentModelLabel,
    providerSubagentEffortLabel, showComposerContextStrip, terminalShortcutLabelOptions, splitTerminalShortcutLabel, splitTerminalVerticalShortcutLabel, newTerminalShortcutLabel,
    closeTerminalShortcutLabel, needsLoadBalancing, loadBalancing, onAutoEnvironmentStable, autoEnvironmentLabel, isEnvironmentChanging,
    readPendingEnvironmentChange, onEnvironmentChangeStable, focusComposer, focusComposerStable, canInterruptRunningThread, onInterrupt,
    onInterruptStable, scheduleComposerFocus, scheduleComposerFocusStable, insertArtifactTemplate, insertArtifactTemplateStable, sendAppMessage,
    sendAppMessageStable, queuedRunsControlRef, activatePanelTerminalStable, addTerminalContextToDraftStable, addTerminalSurfaceStable, closePanelTerminalStable,
    lastInvokedScriptByProjectId, runProjectScriptStable, runShellCommandStable, splitPanelTerminalStable, splitPanelTerminalVerticalStable, toggleTerminalVisibilityStable,
    terminalShortcuts, saveProjectScriptStable, updateProjectScriptStable, deleteProjectScriptStable, canOperatePreview, shownPreviewMiniPlayer,
  };
}
