import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { EMPTY_FEEDBACK_SUBMISSIONS } from "./chatViewTypes";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { useProjectCloneBanner } from "../chat/useProjectCloneBanner";
import {
  applyOptimisticUserMessagesAction,
  createOptimisticBlobPreviews,
  emptyOptimisticUserMessages,
  reconcileOptimisticUserMessages,
} from "../chat/optimisticUserMessages";
import { type TerminalLaunchContext } from "../chat/useChatTerminalActions";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  isProviderNativeSubagentThread,
  type MessageId,
  type ModelSelection,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  deriveProviderSubagentStatus,
  deriveResumableRunId,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveLatestThreadRun,
  deriveThreadStructureRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import {
  resolveWorkflowOpening,
  workflowOpeningParentThreadId,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { threadSupportsProviderHandoff } from "@t3tools/client-runtime/state/thread-workflows";
import { type CodexFeedbackSubmission } from "@t3tools/client-runtime/state/threads";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { useAtomValue } from "@effect/atom-react";
import { type SetStateAction, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDiffPanelStore } from "../../diffPanelStore";
import { useActiveThreadRef } from "../../hooks/useActiveThreadRef";
import { isLatestRunSettled } from "../../session-logic";
import { type LegendListRef } from "@legendapp/list/react";
import { type ChatMessage } from "../../types";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { PopoverCreateHandle } from "../ui/popover";
import {
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { isPreviewSupportedInRuntime, useThreadPreviewState } from "../../previewStateStore";
import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import { createChatCanvasStore } from "../chat/canvasStore";
import {
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../../previewMiniPlayerStore";
import {
  NO_PROVIDER_MODEL_SELECTION,
  resolveProjectDefaultProviderModelSelection,
} from "../../providerInstances";
import { useNowMinute } from "../../hooks/useNowMinute";
import { usePanelAnimationSettings, usePanelPresence } from "../../panelAnimations";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { type DraftThreadEnvMode, useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import {
  useKnownTerminalSessions,
  useThreadRunningTerminalIds,
} from "../../state/terminalSessions";
import { useEnvironment } from "../../state/environments";
import {
  useEnvironmentSupportsServerBrowser,
  useProject,
  useQuietThreadProjection,
  useQuietThreadShell,
} from "../../state/entities";
import { useEnvironmentShellHasSnapshot } from "../../state/shell";
import {
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
} from "../chat/ThreadErrorBanner";
import {
  buildLocalDraftThread,
  shouldRenderPreviewMiniPlayer,
  startNewThreadForProject,
  type LocalThreadErrorEntry,
} from "../ChatView.logic";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { draftFanoutSelectionsAtom, draftSendState } from "../chat/chatViewSend";
import { useChatViewCore } from "./useChatViewCore";

/** Local UI state, workspace layout, and server/draft thread projections. */
export function useChatViewThreadState(prev: ReturnType<typeof useChatViewCore>) {
  const {
  canWriteSourceControl, committedServerMessageIds, composerRuntimeMode, draftId,
  draftThread, embedded, handleNewThread, navigate,
  providersByEnvironment, routeThreadKey, routeThreadRef, serverAcknowledgedUserMessageIds,
  serverProjection, serverThread, settings, threadId,
  } = prev;
  const [isWorkspaceFileDragActive, setIsWorkspaceFileDragActive] = useState(false);
  const [optimisticBlobPreviews] = useState(createOptimisticBlobPreviews);
  const [heldOptimisticUserMessages, setHeldOptimisticUserMessages] = useState(() =>
    emptyOptimisticUserMessages(threadId),
  );
  // Acknowledged messages leave the timeline in the same render the server's copy enters it.
  const optimisticState = reconcileOptimisticUserMessages(
    heldOptimisticUserMessages,
    threadId,
    serverAcknowledgedUserMessageIds,
  );
  if (optimisticState !== heldOptimisticUserMessages) {
    // Idempotent, and a discarded render only delays revocation to the thread's end.
    optimisticBlobPreviews.handOff(optimisticState);
    setHeldOptimisticUserMessages(optimisticState);
  }
  const optimisticUserMessages = optimisticState.messages;
  const setOptimisticUserMessages = (action: SetStateAction<ChatMessage[]>) =>
    setHeldOptimisticUserMessages((state) =>
      applyOptimisticUserMessagesAction(state, threadId, action),
    );
  // Draft ids survive promotion and expire on navigation, keeping the pending resend scoped correctly.
  const [workLocallyResendDraftId, setWorkLocallyResendDraftId] = useState<DraftId | null>(null);
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const feedbackSubmissions =
    feedbackSubmissionsByThreadKey[routeThreadKey] ?? EMPTY_FEEDBACK_SUBMISSIONS;
  const feedbackUploading = feedbackSubmissions.some(
    (submission) => submission.status === "uploading",
  );
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [localServerErrorsByThreadKey, setLocalServerErrorsByThreadKey] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const isRevertingCheckpoint = useComposerDraftStore((store) =>
    store.rewindingThreadKeys.has(routeThreadKey),
  );

  const workspaceFileDragRouteKey = `${routeThreadKey}:${draftId ?? ""}`;
  const [workspaceFileDragRoute, setWorkspaceFileDragRoute] = useState(workspaceFileDragRouteKey);
  if (workspaceFileDragRoute !== workspaceFileDragRouteKey) {
    setWorkspaceFileDragRoute(workspaceFileDragRouteKey);
    setIsWorkspaceFileDragActive(false);
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window dragend listener that clears the workspace file drag state
  useEffect(() => {
    if (!isWorkspaceFileDragActive) return;
    const clearWorkspaceFileDrag = () => setIsWorkspaceFileDragActive(false);
    window.addEventListener("dragend", clearWorkspaceFileDrag);
    return () => window.removeEventListener("dragend", clearWorkspaceFileDrag);
  }, [isWorkspaceFileDragActive]);
  const prefersPlanSidebarSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const isMobileViewport = useMediaQuery("max-sm");
  const [workspaceLayoutElement, setWorkspaceLayoutElement] = useState<HTMLDivElement | null>(null);
  const threadPanelPopoverAnchorRef = useRef<HTMLElement | null>(null);
  const [terminalUiLaunchContext, setTerminalUiLaunchContext] =
    useState<TerminalLaunchContext | null>(null);
  // Overrides chosen before a server thread's first turn; they belong to that thread only.
  const [pendingServerThreadEnvModeEntry, setPendingServerThreadEnvModeEntry] = useState<{
    readonly threadId: ThreadId;
    readonly mode: DraftThreadEnvMode;
  } | null>(null);
  const [pendingServerThreadBranchEntry, setPendingServerThreadBranchEntry] = useState<{
    readonly threadId: ThreadId;
    readonly branch: string | null;
  } | null>(null);
  const [
    pendingServerThreadStartFromOriginByThreadId,
    setPendingServerThreadStartFromOriginByThreadId,
  ] = useState<Record<string, boolean>>({});
  const legendListRef = useRef<LegendListRef | null>(null);
  const conversationArea = workspaceAreaProps("conversation", 1, "Conversation");
  const composerArea = workspaceAreaProps("composer", 2, "Message input");
  const [composerOverlayElement, setComposerOverlayElement] = useState<HTMLDivElement | null>(null);
  const [composerTimelineInset, setComposerTimelineInset] = useState(0);
  const composerTimelineInsetRef = useRef(0);
  const [composerReservedHeight, setComposerReservedHeight] = useState(0);
  const composerReservedHeightRef = useRef(0);
  const composerExpandedHeightRef = useRef(0);
  const [scrollToEndClearance, setScrollToEndClearance] = useState(0);
  const fanoutSelectionsAtom = draftFanoutSelectionsAtom(routeThreadKey);
  const { sendInFlight: sendInFlightRef } = draftSendState(routeThreadKey);
  const multipleModelSelections = useAtomValue(fanoutSelectionsAtom);
  const setMultipleModelSelections = (
    selections: SetStateAction<ReadonlyArray<ModelSelection> | null>,
  ) => {
    appAtomRegistry.update(fanoutSelectionsAtom, (current) =>
      typeof selections === "function" ? selections(current) : selections,
    );
  };
  const setMultipleModelSelectionsStable = useStableCallback(setMultipleModelSelections);
  const feedbackUploadsInFlightRef = useRef(new Set<string>());

  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef),
  );

  const fallbackDraftProjectRef = draftThread
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null;
  const fallbackDraftProject = useProject(fallbackDraftProjectRef);
  const localDraftError = serverThread
    ? null
    : ((draftId ? localDraftErrorsByDraftId[draftId]?.message : null) ?? null);
  const localServerError = localServerErrorsByThreadKey[routeThreadKey]?.message ?? null;
  const promotedDraftError =
    serverThread && draftId ? localDraftErrorsByDraftId[draftId] : undefined;
  if (promotedDraftError !== undefined && draftId) {
    const remainingDraftErrors = { ...localDraftErrorsByDraftId };
    delete remainingDraftErrors[draftId];
    setLocalDraftErrorsByDraftId(remainingDraftErrors);
    const currentEntry = localServerErrorsByThreadKey[routeThreadKey];
    if (
      currentEntry === undefined ||
      (currentEntry.at <= promotedDraftError.at &&
        currentEntry.message !== promotedDraftError.message)
    ) {
      setLocalServerErrorsByThreadKey({
        ...localServerErrorsByThreadKey,
        [routeThreadKey]: promotedDraftError,
      });
    }
  }
  const nowMinute = useNowMinute();
  const draftDefaultModelSelection = draftThread
    ? resolveProjectSettings(
        settings,
        fallbackDraftProject?.id ?? null,
        fallbackDraftProject ?? undefined,
      ).settings.defaultModelSelection
    : null;
  const draftModelResolution = draftThread
    ? resolveNewThreadModelSelection({
        defaultSelection:
          draftDefaultModelSelection ??
          resolveProjectDefaultProviderModelSelection(
            providersByEnvironment.get(draftThread.environmentId) ?? [],
            settings,
            draftThread.projectId,
          ),
        fallbackSelection: settings.fallbackModelSelection,
        providers: providersByEnvironment.get(draftThread.environmentId) ?? [],
        settings,
        projectId: draftThread.projectId,
        now: Date.parse(`${nowMinute}:00Z`),
      })
    : null;
  const draftFallback = draftModelResolution?.fallback ? draftModelResolution : null;
  const localDraftThread = draftThread
    ? buildLocalDraftThread(
        threadId,
        draftThread,
        (draftFallback ? draftFallback.selection : draftDefaultModelSelection) ??
          NO_PROVIDER_MODEL_SELECTION,
      )
    : undefined;
  const isServerThread = serverThread !== null;
  const activeThread = isServerThread ? serverThread : localDraftThread;
  const serverLatestRun =
    serverProjection === null ? null : deriveLatestThreadRun(serverProjection);
  const serverActivityRun =
    serverProjection === null ? null : deriveThreadActivityRun(serverProjection);
  const serverRuntime =
    serverProjection === null ? null : deriveThreadStructureRuntime(serverProjection);
  const runlessWorkStartedAt =
    serverProjection === null ? null : deriveRunlessWorkStartedAt(serverProjection);
  const providerSubagentStatus =
    serverProjection === null ? null : deriveProviderSubagentStatus(serverProjection);
  const isProviderSubagent =
    serverThread !== null && isProviderNativeSubagentThread(serverThread.source);
  const supportsProviderSwitchingViaHandoff = threadSupportsProviderHandoff(serverProjection);
  const activeLatestRun = isServerThread ? serverLatestRun : (activeThread?.latestRun ?? null);
  const activeActivityRun = isServerThread ? serverActivityRun : (activeThread?.latestRun ?? null);
  const activeRuntime = isServerThread ? serverRuntime : (activeThread?.runtime ?? null);
  const hasHeldQueuedRuns =
    isServerThread &&
    serverProjection?.runs.some((run) => run.status === "queued" && run.queueHeld === true) ===
      true;
  const resumableRunId =
    !isServerThread || serverProjection === null
      ? null
      : deriveResumableRunId(serverProjection, serverRuntime);
  const parentSubagentThreadId =
    activeThread?.lineage.relationshipToParent === "subagent"
      ? activeThread.lineage.parentThreadId
      : null;
  const parentSubagentEnvironmentId = activeThread?.environmentId ?? null;
  const parentSubagentThreadRef = (() => {
    if (parentSubagentEnvironmentId === null || parentSubagentThreadId === null) {
      return null;
    }
    return scopeThreadRef(parentSubagentEnvironmentId, parentSubagentThreadId);
  })();
  const parentSubagentThread = useQuietThreadShell(parentSubagentThreadRef);
  // Workflow threads open with a script; their replacement plan lives on the parent's coordinator row.
  const workflowOpeningParentId =
    serverProjection === null
      ? null
      : workflowOpeningParentThreadId({
          thread: serverProjection.thread,
          messages: serverProjection.messages,
        });
  const workflowOpeningParentProjection = useQuietThreadProjection(
    workflowOpeningParentId === null || parentSubagentEnvironmentId === null
      ? null
      : scopeThreadRef(parentSubagentEnvironmentId, workflowOpeningParentId),
  );
  const workflowOpening =
    serverProjection === null || workflowOpeningParentId === null
      ? null
      : resolveWorkflowOpening({
          thread: serverProjection.thread,
          messages: serverProjection.messages,
          parentSubagents: workflowOpeningParentProjection?.projection.subagents ?? null,
        });
  // A linked environment's agent may have delegated this thread from there.
  const delegatedFrom = activeThread?.delegatedFrom ?? null;
  const delegatedFromEnvironment = useEnvironment(delegatedFrom?.environmentId ?? null);
  const delegatedFromRef =
    delegatedFrom === null
      ? null
      : scopeThreadRef(delegatedFrom.environmentId, delegatedFrom.threadId);
  // The title it had at delegation, until this client sees the parent itself.
  const delegatedFromThread = useQuietThreadShell(delegatedFromRef);
  const sideChatParentRef =
    activeThread?.lineage.sideChat === true && activeThread.lineage.parentThreadId !== null
      ? scopeThreadRef(activeThread.environmentId, activeThread.lineage.parentThreadId)
      : null;
  const sideChatParent = useQuietThreadShell(sideChatParentRef);
  const parentThreadLink = (() => {
    if (sideChatParentRef !== null) {
      const title = sideChatParent?.title ?? "Parent thread";
      // Embedded, the parent is the view around it.
      if (embedded) return { title, sideChat: true };
      return {
        title,
        sideChat: true,
        open: (): void => {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(sideChatParentRef),
          });
        },
      };
    }
    if (parentSubagentThreadRef !== null) {
      return {
        title: parentSubagentThread?.title ?? "Parent thread",
        open: (): void => {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(parentSubagentThreadRef),
          });
        },
      };
    }
    if (delegatedFrom === null || delegatedFromRef === null) return null;
    const parentRef = delegatedFromRef;
    return {
      title: delegatedFromThread?.title ?? delegatedFrom.title,
      environmentLabel: delegatedFromEnvironment?.label ?? activeThread?.linkOrigin?.label ?? "",
      // Only an environment this client is connected to can open the parent.
      ...(delegatedFromEnvironment === null
        ? {}
        : {
            open: (): void => {
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(parentRef),
              });
            },
          }),
    };
  })();
  // The header's breadcrumb opens a parent in this environment only.
  const headerParentThreadLink =
    parentSubagentThreadRef === null
      ? null
      : {
          threadId: parentSubagentThreadRef.threadId,
          title: parentSubagentThread?.title ?? "Parent thread",
        };
  const threadError = isServerThread
    ? (localServerError ?? serverRuntime?.lastError ?? null)
    : localDraftError;
  const threadErrorBannerKey = getThreadErrorBannerKey(routeThreadKey, threadError);
  const visibleThreadError = shouldShowThreadErrorBanner(
    routeThreadKey,
    threadError,
    isThreadErrorBannerDismissedForSession(threadErrorBannerKey),
  )
    ? threadError
    : null;
  const [, setThreadErrorBannerDismissTick] = useState(0);
  const threadErrorIsServerRuntimeError =
    localServerError === null && visibleThreadError === serverRuntime?.lastError;
  const defaultRuntimeMode = resolveProjectSettings(settings, activeThread?.projectId ?? null)
    .settings.defaultRuntimeMode;
  const runtimeMode =
    composerRuntimeMode ??
    (isServerThread ? activeThread?.runtimeMode : undefined) ??
    defaultRuntimeMode;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = canWriteSourceControl && isLocalDraftThread;
  const activeThreadId = activeThread?.id ?? null;
  // Turn items can lag projection hydration; keep the environment locked through that gap.
  const activeMessageCount = isServerThread
    ? Math.max(committedServerMessageIds.size, serverProjection?.messages.length ?? 0)
    : 0;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessionsRaw = useKnownTerminalSessions({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessions = (() => {
    if (activeThreadId === null || activeThreadKnownSessionsRaw === null) {
      return [];
    }
    return activeThreadKnownSessionsRaw.filter(
      (session) => session.target.threadId === activeThreadId,
    );
  })();
  const activeServerOrderedTerminalIds = activeThreadKnownSessions.map(
    (session) => session.target.terminalId,
  );
  const activeTerminalLabelsById = (() => {
    const labels = new Map<string, string>();
    for (const session of activeThreadKnownSessions) {
      labels.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      );
    }
    return labels;
  })();
  const activeThreadRef = useActiveThreadRef(activeThread);
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const activeEnvironmentServerBrowser = useEnvironmentSupportsServerBrowser(
    activeThreadRef?.environmentId ?? null,
  );
  const browserAvailable = isPreviewSupportedInRuntime() || activeEnvironmentServerBrowser;
  const activeThreadShell = serverThread;
  const timelineThreadError =
    serverRuntime?.status === "failed" &&
    serverRuntime.lastErrorClass === "usage_limit" &&
    activeThreadShell?.latestRun &&
    visibleThreadError === serverRuntime.lastError
      ? null
      : visibleThreadError;

  const [timelineAnchor, setTimelineAnchor] = useState<{
    readonly threadKey: string | null;
    readonly messageId: MessageId | null;
  }>({ threadKey: activeThreadKey, messageId: null });
  if (timelineAnchor.threadKey !== activeThreadKey) {
    setTimelineAnchor({ threadKey: activeThreadKey, messageId: null });
  }
  const timelineAnchorMessageId = timelineAnchor.messageId;
  // LegendList never recomputes anchored end-space geometry, leaving phantom scroll range after content fits.
  const anchorRunSettled = (() => {
    if (timelineAnchorMessageId === null) return false;
    const anchorRun = serverProjection?.runs.find(
      (run) => run.userMessageId === timelineAnchorMessageId,
    );
    if (anchorRun === undefined) return false;
    return (
      anchorRun.status !== "preparing" &&
      anchorRun.status !== "queued" &&
      anchorRun.status !== "starting" &&
      anchorRun.status !== "running" &&
      anchorRun.status !== "waiting"
    );
  })();
  if (anchorRunSettled) {
    setTimelineAnchor({ threadKey: activeThreadKey, messageId: null });
  }
  const activeRightPanelKind = useRightPanelStore((state) =>
    selectActiveRightPanel(state.byThreadKey, activeThreadRef),
  );
  const diffOpen = activeRightPanelKind === "diff";
  const explicitDiffOpenRef = useRef<ScopedThreadRef | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resets the diff panel store to branch scope when the diff opens without an explicit request
  useLayoutEffect(() => {
    const explicitThreadRef = explicitDiffOpenRef.current;
    explicitDiffOpenRef.current = null;
    if (
      diffOpen &&
      activeThreadRef &&
      explicitThreadRef !== activeThreadRef &&
      !useDiffPanelStore.getState().consumeKeepSelectionOnOpen(activeThreadRef)
    ) {
      useDiffPanelStore.getState().selectGitScope(activeThreadRef, "branch");
    }
  }, [activeThreadRef, diffOpen]);
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, activeThreadRef),
  );
  const shouldUsePlanSidebarSheet = prefersPlanSidebarSheet && rightPanelState.maximized !== true;
  const activeRightPanelSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, activeThreadRef),
  );
  const activePreviewState = useThreadPreviewState(activeThreadRef);
  const activePreviewServerEpoch = activePreviewState.serverEpoch;
  const resolvePreviewRuntimeTabId = activeThreadRef
    ? (tabId: string) => previewRuntimeTabId(activeThreadRef, activePreviewServerEpoch, tabId)
    : undefined;
  const activePreviewMiniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, activeThreadRef),
  );
  const panelTerminalIds = new Set(
    rightPanelState.surfaces.flatMap((surface) =>
      surface.kind === "terminal" ? surface.terminalIds : [],
    ),
  );
  const canReuseTerminal = activeThreadKnownSessionsRaw !== null;
  const previewPanelOpen = activeRightPanelKind === "preview" && browserAvailable;
  const rightPanelOpen = rightPanelState.isOpen;
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const rightPanelPresenceValue = {
    activeSurface: activeRightPanelSurface,
    surfaces: rightPanelState.surfaces,
  };
  const rightPanelPresence = usePanelPresence(
    rightPanelOpen && activeThreadRef !== null,
    rightPanelPresenceValue,
    panelAnimationsActive,
    activeThreadKey,
    panelAnimationDurationMs,
  );
  const rightPanelPresent = rightPanelPresence.present;
  const rightPanelControlsInPanel =
    shouldUsePlanSidebarSheet && rightPanelPresent && rightPanelOpen;
  const rightPanelControlsAtRoot = rightPanelPresent && !shouldUsePlanSidebarSheet;
  const renderedRightPanelSurface = rightPanelPresence.value?.activeSurface ?? null;
  const renderedRightPanelSurfaces = rightPanelPresence.value?.surfaces ?? [];
  const previewMiniPlayerVisible = shouldRenderPreviewMiniPlayer(
    activePreviewMiniPlayer?.source ?? null,
    renderedRightPanelSurface,
  );
  const canMaximizeRightPanel = rightPanelOpen;
  // An embedded side chat has no panel; a stale maximized flag would hide its own column.
  const rightPanelMaximized =
    !embedded && canMaximizeRightPanel && rightPanelState.maximized === true;
  const inlineRightPanelOwnsTitleBar = rightPanelOpen && !shouldUsePlanSidebarSheet;
  const [threadPanelPopoverHandle] = useState(PopoverCreateHandle);
  const [chatCanvasStore] = useState(createChatCanvasStore);

  const latestRunSettled = isLatestRunSettled(activeLatestRun, activeRuntime);
  const activeThreadEnvironmentId = activeThread?.environmentId;
  const activeThreadProjectId = activeThread?.projectId;
  const activeProjectRef =
    activeThreadEnvironmentId !== undefined && activeThreadProjectId !== undefined
      ? scopeProjectRef(activeThreadEnvironmentId, activeThreadProjectId)
      : null;
  const activeProject = useProject(activeProjectRef);
  const activeProjectSettings = resolveProjectSettings(
    settings,
    activeProject?.id ?? null,
    activeProject ?? undefined,
  );
  const activeProjectScripts = activeProject ? resolveProjectScripts(settings, activeProject) : [];
  const { projectCloneBannerItem, projectCloneSendBlockReason } =
    useProjectCloneBanner(activeProjectRef);
  const activeProjectDefaultModelSelection =
    !isServerThread && draftFallback
      ? draftFallback.selection
      : activeProjectSettings.settings.defaultModelSelection;
  const handleNewThreadInActiveProject = () => {
    startNewThreadForProject(activeProjectRef, handleNewThread);
  };
  const handleNewThreadInActiveProjectStable = useStableCallback(handleNewThreadInActiveProject);
  const projectGroupingSettings = selectProjectGroupingSettings(settings);
  const activeDraftLogicalProjectKey =
    !isServerThread && activeProject
      ? deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings)
      : undefined;
  const handleOpenDraftProjectSettings = () => {
    if (!activeDraftLogicalProjectKey) return;
    void navigate({
      to: "/projects/$projectKey",
      params: { projectKey: activeDraftLogicalProjectKey },
    });
  };
  const handleOpenDraftProjectSettingsStable = useStableCallback(handleOpenDraftProjectSettings);
  const activeEnvironmentBootstrapComplete = useEnvironmentShellHasSnapshot(
    activeThread?.environmentId ?? null,
  );
  const activeProjectKey = activeProject
    ? `${activeProject.environmentId}:${activeProject.workspaceRoot}`
    : null;
  const [pendingFileSurfaceIdsByProject, setPendingFileSurfaceIdsByProject] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());

  return {
    ...prev, isWorkspaceFileDragActive, setIsWorkspaceFileDragActive, optimisticBlobPreviews, heldOptimisticUserMessages, setHeldOptimisticUserMessages,
    optimisticState, optimisticUserMessages, setOptimisticUserMessages, workLocallyResendDraftId, setWorkLocallyResendDraftId, feedbackSubmissionsByThreadKey,
    setFeedbackSubmissionsByThreadKey, feedbackSubmissions, feedbackUploading, localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId, localServerErrorsByThreadKey,
    setLocalServerErrorsByThreadKey, isRevertingCheckpoint, workspaceFileDragRouteKey, workspaceFileDragRoute, setWorkspaceFileDragRoute, prefersPlanSidebarSheet,
    isMobileViewport, workspaceLayoutElement, setWorkspaceLayoutElement, threadPanelPopoverAnchorRef, terminalUiLaunchContext, setTerminalUiLaunchContext,
    pendingServerThreadEnvModeEntry, setPendingServerThreadEnvModeEntry, pendingServerThreadBranchEntry, setPendingServerThreadBranchEntry, pendingServerThreadStartFromOriginByThreadId, setPendingServerThreadStartFromOriginByThreadId,
    legendListRef, conversationArea, composerArea, composerOverlayElement, setComposerOverlayElement, composerTimelineInset,
    setComposerTimelineInset, composerTimelineInsetRef, composerReservedHeight, setComposerReservedHeight, composerReservedHeightRef, composerExpandedHeightRef,
    scrollToEndClearance, setScrollToEndClearance, fanoutSelectionsAtom, sendInFlightRef, multipleModelSelections, setMultipleModelSelections,
    setMultipleModelSelectionsStable, feedbackUploadsInFlightRef, terminalUiState, fallbackDraftProjectRef, fallbackDraftProject, localDraftError,
    localServerError, promotedDraftError, nowMinute, draftDefaultModelSelection, draftModelResolution, draftFallback,
    localDraftThread, isServerThread, activeThread, serverLatestRun, serverActivityRun, serverRuntime,
    runlessWorkStartedAt, providerSubagentStatus, isProviderSubagent, supportsProviderSwitchingViaHandoff, activeLatestRun, activeActivityRun,
    activeRuntime, hasHeldQueuedRuns, resumableRunId, parentSubagentThreadId, parentSubagentEnvironmentId, parentSubagentThreadRef,
    parentSubagentThread, workflowOpeningParentId, workflowOpeningParentProjection, workflowOpening, delegatedFrom, delegatedFromEnvironment,
    delegatedFromRef, delegatedFromThread, sideChatParentRef, sideChatParent, parentThreadLink, headerParentThreadLink,
    threadError, threadErrorBannerKey, visibleThreadError, setThreadErrorBannerDismissTick, threadErrorIsServerRuntimeError, defaultRuntimeMode,
    runtimeMode, isLocalDraftThread, canCheckoutPullRequestIntoThread, activeThreadId, activeMessageCount, runningTerminalIds,
    activeThreadKnownSessionsRaw, activeThreadKnownSessions, activeServerOrderedTerminalIds, activeTerminalLabelsById, activeThreadRef, activeThreadKey,
    activeEnvironmentServerBrowser, browserAvailable, activeThreadShell, timelineThreadError, timelineAnchor, setTimelineAnchor,
    timelineAnchorMessageId, anchorRunSettled, activeRightPanelKind, diffOpen, explicitDiffOpenRef, rightPanelState,
    shouldUsePlanSidebarSheet, activeRightPanelSurface, activePreviewState, activePreviewServerEpoch, resolvePreviewRuntimeTabId, activePreviewMiniPlayer,
    panelTerminalIds, canReuseTerminal, previewPanelOpen, rightPanelOpen, panelAnimationsActive, panelAnimationDurationMs,
    rightPanelPresenceValue, rightPanelPresence, rightPanelPresent, rightPanelControlsInPanel, rightPanelControlsAtRoot, renderedRightPanelSurface,
    renderedRightPanelSurfaces, previewMiniPlayerVisible, canMaximizeRightPanel, rightPanelMaximized, inlineRightPanelOwnsTitleBar, threadPanelPopoverHandle,
    chatCanvasStore, latestRunSettled, activeThreadEnvironmentId, activeThreadProjectId, activeProjectRef, activeProject,
    activeProjectSettings, activeProjectScripts, projectCloneBannerItem, projectCloneSendBlockReason, activeProjectDefaultModelSelection, handleNewThreadInActiveProject,
    handleNewThreadInActiveProjectStable, projectGroupingSettings, activeDraftLogicalProjectKey, handleOpenDraftProjectSettings, handleOpenDraftProjectSettingsStable, activeEnvironmentBootstrapComplete,
    activeProjectKey, pendingFileSurfaceIdsByProject, setPendingFileSurfaceIdsByProject,
  };
}
