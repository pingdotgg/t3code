import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { configuredHostedAppUrl } from "../../hostedPairing";
import { useStableCallback } from "../../hooks/useStableCallback";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { type ThreadId, ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { resolveThreadReferenceCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { useEffect, useLayoutEffect, useState } from "react";
import { useStore } from "zustand";
import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { useThreadPreviewCanvasSource } from "../preview/ThreadPreviewMiniPlayer";
import { resolveChatCanvasModel } from "../chat/canvasStore";
import { useDeviceState } from "~/state/device";
import { isInSideChatPane } from "~/lib/sideChatPane";
import { useOpenPanelPullRequestUrl } from "../../hooks/useOpenPanelPullRequestUrl";
import { type DraftThreadEnvMode } from "../../composerDraftStore";
import { resolveScrollToEndClearance } from "../composerFooterLayout";
import {
  resolveEffectiveEnvMode,
  resolveLocalCheckoutBranchMismatch,
} from "../BranchToolbar.logic";
import { useThreadLinkedPullRequest } from "../pullRequest/useThreadLinkedPullRequest";
import { useProactivePanels } from "../../hooks/useProactivePanels";
import { useRightPanelSurfaceClose } from "../../hooks/useRightPanelSurfaceClose";
import {
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  shouldRefocusComposerOnWindowFocus,
} from "../ChatView.logic";
import { observeResize } from "~/lib/observeResize";
import { useTimelineFollow } from "../chat/useTimelineFollow";
import { useChatViewActions } from "./useChatViewActions";

/** Terminal, preview, pull request, and right-panel actions. */
export function useChatViewPanelActions(prev: ReturnType<typeof useChatViewActions>) {
  const {
  activeActivityRun, activeLatestRun, activeMessageCount, activeProject,
  activeProjectSettings, activeRuntime, activeTerminalLabelsById, activeThread,
  activeThreadKey, activeThreadRef, activeThreadShell, canMaximizeRightPanel,
  chatCanvasStore, clientSettingsHydrated, composerExpandedHeightRef, composerMounted,
  composerOverlayElement, composerReservedHeightRef, composerTimelineInset, composerTimelineInsetRef,
  draftThread, embedded, envLocked, environmentId,
  focusComposerStable, gitStatusQuery, interactionMode, isDraftHeroState,
  isGitRepo, isLocalDraftThread, isMobileViewport, isPreparingWorktree,
  isServerThread, latestRunSettled, legendListRef, onDiffPanelOpen,
  pendingServerThreadBranchEntry, pendingServerThreadEnvModeEntry, pendingServerThreadStartFromOriginByThreadId, pullRequestsCapabilityKnown,
  resetLocalDispatch, routeThreadKey, routeThreadRef, runtimeMode,
  serverConfig, serverProjection, serverThread, setComposerReservedHeight,
  setComposerTimelineInset, setPendingServerThreadBranchEntry, setPendingServerThreadEnvModeEntry, setScrollToEndClearance,
  setThreadInteractionMode, setThreadRuntimeMode, setTimelineAnchor, settings,
  shouldUsePlanSidebarSheet, shownPreviewMiniPlayer, supportsPullRequests, terminalUiState,
  threadDetailLoading, threadId, threadStatus, timelineAnchorMessageId,
  timelineEntries, turnDiffSummaries, updateThreadMetadata,
  } = prev;
  const canvasPreview = useThreadPreviewCanvasSource(activeThreadRef, shownPreviewMiniPlayer);
  const threadPanelInlineOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, activeThreadRef, "inline"),
  );
  // Selects only the mode, so canvas resizes rerender the chat view only when the
  // card switches presentation.
  const threadPanelPresentation = useStore(
    chatCanvasStore,
    (state) =>
      resolveChatCanvasModel({
        measurements: state.measurements,
        detailsCardMeasurement: state.detailsCardMeasurement,
        threadRef: activeThreadRef,
        preview: canvasPreview,
        detailsCardInlineOpen: threadPanelInlineOpen,
      }).detailsCardMode,
  );
  const threadPanelOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(
      state.threadPanelVisibilityByThreadKey,
      activeThreadRef,
      threadPanelPresentation,
    ),
  );
  const supportsThreadPullRequests = serverConfig !== null;
  const visiblePullRequests = visibleThreadPullRequests(
    (activeThreadShell ?? activeThread)?.pullRequests ?? [],
  );
  const visiblePullRequestCount = visiblePullRequests.length;
  const pullRequestsSurfaceAvailable =
    isServerThread && supportsThreadPullRequests && visiblePullRequestCount > 0;
  const { state: deviceState, loaded: deviceStateLoaded } = useDeviceState(
    activeThreadRef?.environmentId ?? null,
  );
  // The thread's own change request, placed against the project it belongs to. Without a
  // project there is nothing to resolve it against, so the caller falls back to the browser.
  const activeProjectRepository = sourceControlClients.repositorySelector(
    activeProject?.repositoryIdentity,
  );
  const {
    linked: linkedThreadPullRequest,
    linkedKey: linkedThreadPullRequestKey,
    hasDetail: hasLinkedPullRequestDetail,
  } = useThreadLinkedPullRequest({
    serverThreadRef: isServerThread ? activeThreadRef : null,
    environmentId: activeThreadRef?.environmentId ?? null,
    persisted: isServerThread
      ? (activeThreadShell?.linkedPullRequest ?? activeThread?.linkedPullRequest ?? null)
      : (activeThread?.linkedPullRequest ?? null),
    projectId: activeProject?.id ?? null,
    projectRepository: activeProjectRepository,
    threadBranch: activeThread?.branch ?? null,
    gitStatus: gitStatusQuery.data ?? null,
  });
  const proactivePullRequestsKey = pullRequestsSurfaceAvailable
    ? JSON.stringify(
        visiblePullRequests.map((link) => [link.host, link.repository, link.number]).sort(),
      )
    : linkedThreadPullRequestKey;
  const activeRunningTurnId = activeRuntime?.activeRunId ?? null;
  useProactivePanels({
    threadRef: isServerThread && !embedded ? activeThreadRef : null,
    enabled: settings.proactivePanelsEnabled && !shouldUsePlanSidebarSheet && !embedded,
    settingsHydrated: clientSettingsHydrated,
    threadDetailLoading,
    runningTurnId: activeRunningTurnId,
    latestRun: activeLatestRun,
    latestRunSettled,
    turnDiffSummaries,
    isGitRepo: gitStatusQuery.data?.isRepo,
    linkedPullRequest: linkedThreadPullRequest,
    hasLinkedPullRequestDetail,
    pullRequestsKey: proactivePullRequestsKey,
    pullRequestsCapabilityKnown,
    supportsPullRequests,
    pullRequestsSurfaceAvailable,
    visiblePullRequestCount,
    onDiffPanelOpen,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- consumes a pending maximize request from the right panel store once the panel can maximize
  useEffect(() => {
    if (!canMaximizeRightPanel) return;
    if (useRightPanelStore.getState().consumeMaximizeRequest(routeThreadRef)) {
      useRightPanelStore.getState().setMaximized(routeThreadRef, true);
    }
  }, [canMaximizeRightPanel, routeThreadRef]);
  const {
    closeSurface: closeRightPanelSurface,
    closeOtherSurfaces: closeOtherRightPanelSurfacesStable,
    closeSurfacesToRight: closeRightPanelSurfacesToRightStable,
    closeAllSurfaces: closeAllRightPanelSurfacesStable,
  } = useRightPanelSurfaceClose({
    threadRef: activeThreadRef,
    terminalLabelsById: activeTerminalLabelsById,
  });
  const closeRightPanelSurfaceStable = closeRightPanelSurface;
  const persistThreadSettingsForNextTurn = async (input: {
    threadId: ThreadId;
    createdAt: string;
    branch?: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }): Promise<AtomCommandResult<void, unknown>> => {
    if (!serverThread) {
      return AsyncResult.success(undefined);
    }

    let result: AtomCommandResult<void, unknown> = AsyncResult.success(undefined);
    const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
      currentModelSelection: serverThread.modelSelection,
      currentBranch: serverThread.branch,
      ...(input.branch ? { nextBranch: input.branch } : {}),
    });
    if (metadataUpdate) {
      result = mapAtomCommandResult(
        await updateThreadMetadata({
          environmentId,
          input: {
            threadId: input.threadId,
            ...metadataUpdate,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        return result;
      }
    }

    if (input.runtimeMode !== serverThread.runtimeMode) {
      result = mapAtomCommandResult(
        await setThreadRuntimeMode({
          environmentId,
          input: {
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            createdAt: input.createdAt,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        return result;
      }
    }

    if (input.interactionMode !== serverThread.interactionMode) {
      result = mapAtomCommandResult(
        await setThreadInteractionMode({
          environmentId,
          input: {
            threadId: input.threadId,
            interactionMode: input.interactionMode,
            createdAt: input.createdAt,
          },
        }),
        () => undefined,
      );
    }
    return result;
  };

  const {
    showScrollToBottom,
    timelineLiveFollowEnabled,
    onComposerPageScrollKeyDownStable,
    onComposerPageScrollKeyUpStable,
    onComposerPageScrollReleaseStable,
    scrollToEnd,
    onTimelineAnchorReadyStable,
    onTimelineAnchorSizeChangedStable,
    onTimelineFooterGrowStable,
    onIsAtEndChangeStable,
    anchorNewTurn,
    attachTimelineViewport,
    attachComposerOverlay: attachFollowComposerOverlay,
  } = useTimelineFollow({
    legendListRef,
    composerTimelineInset,
    routeThreadKey,
    activeThreadKey,
    isServerThread,
    serverProjection,
    threadStatus,
    activeActivityRun,
    activeRunningTurnId,
    timelineEntries,
    timelineAnchorMessageId,
    setTimelineAnchor,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules a frame to focus the composer DOM element when a thread opens with the terminal closed
  useEffect(() => {
    if (embedded || !activeThread?.id || terminalUiState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposerStable();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, embedded, focusComposerStable, terminalUiState.terminalOpen]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window focus listener that refocuses the composer after the window regains focus
  useEffect(() => {
    if (embedded || !activeThread?.id || terminalUiState.terminalOpen || isMobileViewport) return;
    let frame: number | null = null;
    const onWindowFocus = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      // Wait an extra frame after window focus so the composer treats focus as an expansion request.
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          if (document.querySelector("[data-mcp-app-fullscreen]") !== null) return;
          if (
            !isInSideChatPane(document.activeElement) &&
            shouldRefocusComposerOnWindowFocus(document.activeElement)
          ) {
            focusComposerStable();
          }
        });
      });
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [
    activeThread?.id,
    embedded,
    focusComposerStable,
    isMobileViewport,
    terminalUiState.terminalOpen,
  ]);

  // Promotion drops draftId while a send may still be dispatching, so key by thread.
  const [localDispatchThreadId, setLocalDispatchThreadId] = useState(threadId);
  if (localDispatchThreadId !== threadId) {
    setLocalDispatchThreadId(threadId);
    resetLocalDispatch();
  }

  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const derivedEnvMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: isServerThread,
    draftThreadEnvMode: isLocalDraftThread ? draftThread?.envMode : undefined,
    preparingWorktree: isPreparingWorktree,
  });
  const canOverrideServerThreadEnvMode = Boolean(
    isServerThread &&
    activeThread &&
    activeMessageCount === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  );
  if (
    !canOverrideServerThreadEnvMode &&
    (pendingServerThreadEnvModeEntry !== null || pendingServerThreadBranchEntry !== null)
  ) {
    setPendingServerThreadEnvModeEntry(null);
    setPendingServerThreadBranchEntry(null);
  }
  const pendingServerThreadEnvMode =
    pendingServerThreadEnvModeEntry !== null &&
    pendingServerThreadEnvModeEntry.threadId === activeThread?.id
      ? pendingServerThreadEnvModeEntry.mode
      : null;
  const pendingServerThreadBranchEntryForThread =
    pendingServerThreadBranchEntry?.threadId === activeThread?.id
      ? pendingServerThreadBranchEntry
      : null;
  const setPendingServerThreadBranch = (branch: string | null) => {
    if (activeThread) setPendingServerThreadBranchEntry({ threadId: activeThread.id, branch });
  };
  const envMode: DraftThreadEnvMode = canOverrideServerThreadEnvMode
    ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
    : derivedEnvMode;
  const activeThreadBranch =
    canOverrideServerThreadEnvMode && pendingServerThreadBranchEntryForThread !== null
      ? pendingServerThreadBranchEntryForThread.branch
      : (activeThread?.branch ?? null);
  const startFromOrigin = isLocalDraftThread
    ? (draftThread?.startFromOrigin ?? false)
    : canOverrideServerThreadEnvMode
      ? (pendingServerThreadStartFromOriginByThreadId[activeThread?.id ?? ""] ??
        activeProjectSettings.settings.newWorktreesStartFromOrigin)
      : false;
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  });
  const localCheckoutBranchMismatch = isServerThread
    ? resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: envMode,
        activeWorktreePath,
        activeThreadBranch,
        currentGitBranch: gitStatusQuery.data?.refName ?? null,
      })
    : null;
  const publishComposerOverlayHeight = (height: number) => {
    const nextHeight = Math.ceil(height);
    if (nextHeight <= 0) return;
    if (composerTimelineInsetRef.current !== nextHeight) {
      composerTimelineInsetRef.current = nextHeight;
      setComposerTimelineInset(nextHeight);
    }
    // Reserve the expanded composer height for the terminal drawer and empty placeholder.
    // Keep it while the mobile strip collapses, but allow growth from approvals or tasks.
    // A hero overlay fills the pane, so reserve only its stack.
    const stack = composerOverlayElement?.querySelector<HTMLElement>(
      '[data-chat-composer-stack="true"]',
    );
    const expandedComposerHeight =
      isDraftHeroState && stack ? Math.ceil(stack.getBoundingClientRect().height) : nextHeight;
    const mobileCollapsed = Boolean(
      stack?.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
    );
    if (!mobileCollapsed) composerExpandedHeightRef.current = expandedComposerHeight;
    const reservedHeight = Math.max(composerExpandedHeightRef.current, expandedComposerHeight);
    if (composerReservedHeightRef.current !== reservedHeight) {
      composerReservedHeightRef.current = reservedHeight;
      setComposerReservedHeight(reservedHeight);
    }
    const mainSurface = composerOverlayElement?.querySelector<HTMLElement>(
      '[data-chat-composer-main-surface="true"]',
    );
    const button =
      composerOverlayElement?.parentElement?.querySelector<HTMLElement>("[data-scroll-to-end]");
    const clearance =
      composerOverlayElement && mainSurface && button
        ? resolveScrollToEndClearance({
            overlayHeight: nextHeight,
            mainSurfaceTop: mainSurface.getBoundingClientRect().top,
            button: button.getBoundingClientRect(),
            attachments: Array.from(
              composerOverlayElement.querySelectorAll<HTMLElement>(
                '[data-composer-banner-surface="attached"]',
              ),
              (element) => element.getBoundingClientRect(),
            ),
          })
        : nextHeight;
    setScrollToEndClearance(clearance);
  };
  const publishComposerOverlayHeightStable = useStableCallback(publishComposerOverlayHeight);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the composer overlay element before paint for a new thread or composer mount
  useLayoutEffect(() => {
    if (!composerOverlayElement) return;
    composerTimelineInsetRef.current = 0;
    composerReservedHeightRef.current = 0;
    composerExpandedHeightRef.current = 0;
    publishComposerOverlayHeightStable(composerOverlayElement.getBoundingClientRect().height);
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A thread switch or a composer mount/unmount must re-measure the overlay for the new timeline.
    activeThreadKey,
    composerMounted,
    composerOverlayElement,
    publishComposerOverlayHeightStable,
  ]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the composer overlay element's size before paint and publishes its height
  useLayoutEffect(() => {
    if (!composerOverlayElement) return;

    const updateHeight = () => {
      publishComposerOverlayHeightStable(composerOverlayElement.getBoundingClientRect().height);
    };

    updateHeight();
    // The hero overlay fills the pane, so the composer's own growth only shows on its stack.
    const stack = isDraftHeroState
      ? composerOverlayElement.querySelector<HTMLElement>('[data-chat-composer-stack="true"]')
      : null;
    return observeResize(
      stack ? [composerOverlayElement, stack] : composerOverlayElement,
      updateHeight,
    );
  }, [
    composerOverlayElement,
    isDraftHeroState,
    publishComposerOverlayHeightStable,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The scroll-to-bottom button changes the overlay's height without resizing the observed node first.
    showScrollToBottom,
  ]);
  const openPanelPullRequestUrl = useOpenPanelPullRequestUrl(activeThreadRef);
  const activeThreadReferenceCopyTarget =
    activeThreadRef === null || !isServerThread
      ? null
      : resolveThreadReferenceCopyTarget({
          threadRef: activeThreadRef,
          title: activeThread?.title ?? "",
          openPanelPullRequestUrl,
          pullRequests: activeThread?.pullRequests,
          linkedPullRequestUrl: linkedThreadPullRequest?.url ?? null,
          hostedAppUrl: configuredHostedAppUrl(),
        });

  return {
    ...prev, canvasPreview, threadPanelInlineOpen, threadPanelPresentation, threadPanelOpen, supportsThreadPullRequests,
    visiblePullRequests, visiblePullRequestCount, pullRequestsSurfaceAvailable, deviceState, deviceStateLoaded, activeProjectRepository,
    linkedThreadPullRequest, linkedThreadPullRequestKey, hasLinkedPullRequestDetail, proactivePullRequestsKey, activeRunningTurnId, closeRightPanelSurface,
    closeOtherRightPanelSurfacesStable, closeRightPanelSurfacesToRightStable, closeAllRightPanelSurfacesStable, closeRightPanelSurfaceStable, persistThreadSettingsForNextTurn, showScrollToBottom,
    timelineLiveFollowEnabled, onComposerPageScrollKeyDownStable, onComposerPageScrollKeyUpStable, onComposerPageScrollReleaseStable, scrollToEnd, onTimelineAnchorReadyStable,
    onTimelineAnchorSizeChangedStable, onTimelineFooterGrowStable, onIsAtEndChangeStable, anchorNewTurn, attachTimelineViewport, attachFollowComposerOverlay,
    localDispatchThreadId, setLocalDispatchThreadId, activeWorktreePath, derivedEnvMode, canOverrideServerThreadEnvMode, pendingServerThreadEnvMode,
    pendingServerThreadBranchEntryForThread, setPendingServerThreadBranch, envMode, activeThreadBranch, startFromOrigin, sendEnvMode,
    localCheckoutBranchMismatch, publishComposerOverlayHeight, publishComposerOverlayHeightStable, openPanelPullRequestUrl, activeThreadReferenceCopyTarget,
  };
}
