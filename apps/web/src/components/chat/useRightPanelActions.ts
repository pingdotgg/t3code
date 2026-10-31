import type { ToolCallDiffTarget } from "../../diffPanelStore";
import { AuthTerminalOperateScope } from "@t3tools/contracts";
import { useEnvironmentScope } from "../../state/session";
import { useEffect } from "react";
import { useLayoutPane, useLayoutPaneOwnsThreadRef } from "../../layout/layoutPaneContext";
import { registerLayoutOpenBesideAction, type LayoutBesideKind } from "../../layout/layoutActions";
import { requestLayoutSurfacePlacement } from "../../layout/surfaceSync";
import { getLayoutBehavior } from "../../layout/layoutBehavior";
import { toggleThreadSidePane } from "../../layout/openRules";
import type { useChatTerminalActions } from "./useChatTerminalActions";
import { isPreviewSupportedInRuntime } from "../../previewStateStore";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ThreadPreviewState } from "../../previewStateStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { type ScopedThreadRef, type RunId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useDiffPanelStore } from "../../diffPanelStore";
import { type ThreadPanelPresentation } from "../../rightPanelLayout";
import {
  selectActiveRightPanel,
  selectThreadPanelOpen,
  type RightPanelSurface,
  useRightPanelStore,
} from "../../rightPanelStore";
import { requestWorkspaceContentFocus, requestWorkspaceFocus } from "../../lib/workspaceFocus";
import { BrowserSettingsReadError } from "../../browser/openFileInPreview";
import { addBrowserSurface } from "../preview/addBrowserSurface";
import { subscribePreviewAction } from "../preview/previewActionBus";
import { floatDeviceSurface } from "../preview/agentOpenedPreviews";
import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import type { threadPullRequestPanelTarget } from "../pullRequest/pullRequestDetail.logic";
import type { useDeviceState } from "../../state/device";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { openDeviceSetupDialog } from "./ChatOverlayHosts";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ChatShortcutCommands } from "./useChatShortcuts";
interface RightPanelActionsInput {
  readonly startTerminal: ReturnType<typeof useChatTerminalActions>["startTerminal"];
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeProject: EnvironmentProject | null;
  readonly activeRightPanelSurface: RightPanelSurface | null;
  readonly activePreviewState: ThreadPreviewState;
  readonly deviceState: ReturnType<typeof useDeviceState>["state"];
  readonly deviceStateLoaded: boolean;
  readonly pullRequestPanelTarget: ReturnType<typeof threadPullRequestPanelTarget> | null;
  readonly threadPanelPresentation: ThreadPanelPresentation;
  readonly isServerThread: boolean;
  /** A side chat pane; the main view already answers preview bus actions. */
  readonly embedded: boolean;
  readonly isGitRepo: boolean;
  readonly browserAvailable: boolean;
  readonly canOperatePreview: boolean;
  readonly diffOpen: boolean;
  readonly previewPanelOpen: boolean;
  readonly supportsPullRequests: boolean;
  readonly pullRequestsSurfaceAvailable: boolean;
  readonly explicitDiffOpenRef: { current: ScopedThreadRef | null };
  readonly onDiffPanelOpen: (() => void) | undefined;
}

/**
 * Opens surface tabs beside the owning chat, including the palette's and header's
 * open-beside actions. Surface tabs own their rendering, arrangement, and closing.
 */
export function useRightPanelActions(input: RightPanelActionsInput) {
  const {
    startTerminal,
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
    supportsPullRequests,
    pullRequestsSurfaceAvailable,
    explicitDiffOpenRef,
    onDiffPanelOpen,
  } = input;

  const layoutPane = useLayoutPane();
  const layoutPaneOwnsThreadRef = useLayoutPaneOwnsThreadRef();
  const ownsThread = layoutPane.focused || layoutPane.related;
  const canOperateTerminal = useEnvironmentScope(
    activeThreadRef?.environmentId ?? null,
    AuthTerminalOperateScope,
  );
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const onToggleDiff = () => {
    if (!isServerThread) {
      return;
    }
    if (!diffOpen) {
      onDiffPanelOpen?.();
    }
    if (activeThreadRef) {
      useRightPanelStore.getState().toggle(activeThreadRef, "diff");
    }
  };
  const createBrowserSurface = (profileId?: string) => {
    if (!activeThreadRef || !canOperatePreview) return;
    void addBrowserSurface({
      threadRef: activeThreadRef,
      openPreview,
      ...(profileId === undefined ? {} : { profileId }),
    }).then((result) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      if (error instanceof BrowserSettingsReadError) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open browser",
            description: error.message,
          }),
        );
      }
    });
  };
  const addDiffSurface = () => {
    if (!activeThreadRef || !isServerThread || !isGitRepo) return;
    useDiffPanelStore.getState().selectGitScope(activeThreadRef, "branch");
    useRightPanelStore.getState().open(activeThreadRef, "diff");
    onDiffPanelOpen?.();
  };
  const openChangesFromThreadPanel = () => {
    addDiffSurface();
  };
  const openChangesFromThreadPanelStable = useStableCallback(openChangesFromThreadPanel);
  const addFilesSurface = () => {
    if (!activeThreadRef || !activeProject) return;
    useRightPanelStore.getState().open(activeThreadRef, "files");
  };
  const addPullRequestsSurface = () => {
    if (!activeThreadRef || !pullRequestsSurfaceAvailable) return;
    useRightPanelStore.getState().open(activeThreadRef, "pull-requests");
  };
  const addDeviceSurface = () => {
    if (!activeThreadRef) return;
    if (!deviceState.onboardingCompleted || deviceState.hostStatus === "disabled") {
      openDeviceSetupDialog(scopedThreadKey(activeThreadRef));
      return;
    }
    useRightPanelStore.getState().open(activeThreadRef, "device");
  };
  const closePreviewPanel = () => {
    if (activeThreadRef) {
      if (activeRightPanelSurface?.kind === "preview" && activeRightPanelSurface.resourceId) {
        usePreviewMiniPlayerStore
          .getState()
          .open(activeThreadRef, browserMiniPlayerSource(activeRightPanelSurface.resourceId));
      } else if (activeRightPanelSurface?.kind === "device" && activeRightPanelSurface.target) {
        floatDeviceSurface(
          activeThreadRef,
          { kind: "device", ...activeRightPanelSurface.target },
          deviceStateLoaded ? deviceState : null,
        );
      }
      useRightPanelStore.getState().close(activeThreadRef);
    }
  };
  const togglePreviewPanel = () => {
    if (!activeThreadRef || !browserAvailable) return;
    if (previewPanelOpen) {
      closePreviewPanel();
      return;
    }
    if (!canOperatePreview) return;
    const activeTabId = activePreviewState.activeTabId;
    if (activeTabId) {
      useRightPanelStore.getState().openBrowser(activeThreadRef, activeTabId);
    } else {
      createBrowserSurface();
    }
  };
  const togglePreviewPanelStable = useStableCallback(togglePreviewPanel);
  const toggleThreadPanel = () => {
    if (!activeThreadRef) return;
    const store = useRightPanelStore.getState();
    if (threadPanelPresentation === "inline") {
      const open = selectThreadPanelOpen(
        store.threadPanelVisibilityByThreadKey,
        activeThreadRef,
        "inline",
      );
      if (!open) requestWorkspaceFocus({ area: "details" });
      else if (document.activeElement?.closest('[data-workspace-area="details"]'))
        requestWorkspaceContentFocus();
    }
    store.toggleThreadPanel(activeThreadRef, threadPanelPresentation);
  };
  const toggleThreadPanelStable = useStableCallback(toggleThreadPanel);
  const addPullRequestSurface = () => {
    if (!supportsPullRequests || activeThreadRef === null || pullRequestPanelTarget === null)
      return;
    useRightPanelStore.getState().openPullRequest(activeThreadRef, pullRequestPanelTarget);
  };
  const pullRequestSurfaceAvailable = supportsPullRequests && pullRequestPanelTarget !== null;
  // Settings › Layout › Side pane opens on: a set surface, or the last one
  // used (pen hJiZ5). Returns whether it opened one; the caller shows a
  // launcher otherwise, so you see what you are opening.
  const openSidePaneDefault = (): boolean => {
    if (!activeThreadRef) return false;
    const opensOn = getLayoutBehavior().sidePaneOpensOn;
    if (opensOn === "diff" && isServerThread && isGitRepo) return (addDiffSurface(), true);
    if (opensOn === "files" && activeProject) return (addFilesSurface(), true);
    if (opensOn === "browser" && isPreviewSupportedInRuntime()) {
      createBrowserSurface();
      return true;
    }
    if (opensOn === "pull-request" && pullRequestSurfaceAvailable) {
      addPullRequestSurface();
      return true;
    }
    return false;
  };
  const openSidePaneDefaultStable = useStableCallback(openSidePaneDefault);
  // "Open beside…" (palette, new tab page) reaches the focused chat's side
  // pane and terminal through this registration.
  const browserBesideAvailable = canOperatePreview && browserAvailable;
  const diffBesideAvailable = isServerThread && isGitRepo;
  const projectBesideAvailable = activeProject !== null;
  // Also what the header's "+" offers after a new thread.
  const besideAvailable = (() => {
    const available = new Set<LayoutBesideKind>();
    if (diffBesideAvailable) available.add("diff");
    if (projectBesideAvailable) available.add("files");
    if (projectBesideAvailable && canOperateTerminal) available.add("terminal");
    if (browserBesideAvailable) available.add("browser");
    if (pullRequestSurfaceAvailable) available.add("pull-request");
    if (pullRequestsSurfaceAvailable) available.add("pull-requests");
    if (activeThreadRef !== null) available.add("device");
    return available;
  })();
  const openBeside = (
    kind: LayoutBesideKind,
    paneId?: string | null,
    browserProfileId?: string,
  ) => {
    if (activeThreadRef === null) return;
    const targetPaneId = paneId === undefined ? layoutPane.paneId : paneId;
    // The palette and the "+" menu open the surface as a tab of their pane.
    if (targetPaneId !== null) {
      requestLayoutSurfacePlacement(activeThreadRef, { kind: "pane", paneId: targetPaneId });
    }
    if (kind === "diff") addDiffSurface();
    else if (kind === "files") addFilesSurface();
    else if (kind === "browser") createBrowserSurface(browserProfileId);
    else if (kind === "pull-request") addPullRequestSurface();
    else if (kind === "pull-requests") addPullRequestsSurface();
    else if (kind === "device") addDeviceSurface();
    else
      startTerminal((threadRef, terminalId) =>
        useRightPanelStore.getState().openTerminal(threadRef, terminalId),
      );
  };
  const openBesideStable = useStableCallback(openBeside);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Expose only the focused pane actions to the imperative layout launcher and palette.
  useEffect(() => {
    if (!ownsThread) return;
    return registerLayoutOpenBesideAction({ available: besideAvailable, open: openBesideStable });
  }, [besideAvailable, ownsThread, openBesideStable]);

  const onOpenTurnDiff = (runId: RunId, filePath?: string) => {
    if (!isServerThread || !activeThreadRef) return;
    const diffOpen =
      selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, activeThreadRef) === "diff";
    explicitDiffOpenRef.current = diffOpen ? null : activeThreadRef;
    useDiffPanelStore.getState().selectTurn(activeThreadRef, runId, filePath);
    useRightPanelStore.getState().open(activeThreadRef, "diff");
    onDiffPanelOpen?.();
  };
  const onOpenToolDiffStable = useStableCallback((target: ToolCallDiffTarget) => {
    if (!isServerThread || !activeThreadRef) return;
    const diffOpen =
      selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, activeThreadRef) === "diff";
    explicitDiffOpenRef.current = diffOpen ? null : activeThreadRef;
    useDiffPanelStore.getState().selectToolCall(activeThreadRef, target);
    useRightPanelStore.getState().open(activeThreadRef, "diff");
    onDiffPanelOpen?.();
  });
  const onOpenTurnDiffStable = useStableCallback(onOpenTurnDiff);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the preview action bus to toggle the preview panel
  useEffect(
    () =>
      subscribePreviewAction((action) => {
        if (embedded || !layoutPaneOwnsThreadRef.current) return;
        if (action === "toggle-panel") togglePreviewPanelStable();
      }),
    [embedded, togglePreviewPanelStable, layoutPaneOwnsThreadRef],
  );

  const toggleSidePane = () => {
    if (activeThreadRef !== null) toggleThreadSidePane(activeThreadRef, openSidePaneDefaultStable);
  };
  const shortcuts = {
    "rightPanel.toggle": () => toggleSidePane(),
    "threadPanel.toggle": () => toggleThreadPanel(),
    "diff.toggle": () => onToggleDiff(),
  } satisfies ChatShortcutCommands;

  return {
    shortcuts,
    besideAvailable,
    openBesideStable,
    onOpenToolDiffStable,
    onOpenTurnDiffStable,
    openChangesFromThreadPanelStable,
    toggleThreadPanelStable,
  };
}
