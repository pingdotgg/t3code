import { RightPanelSurfaceContent } from "../chat/RightPanelSurfaceContent";
import { FileMetadataThreadProvider } from "../../hooks/FileMetadataThreadProvider";
import { makeWorkspaceFileDropHandlers } from "../chat/workspaceFileDrop";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  PanelLayoutControls,
  type PanelLayoutControlsProps,
  ThreadPanelHeaderControl,
  WorkspaceTitlebarControls,
} from "../chat/PanelLayoutControls";
import { NoActiveThreadState } from "../NoActiveThreadState";
import type { ChatViewState } from "./useChatViewState";
import { ChatViewContent } from "./ChatViewContent";

/** Renders the chat surfaces for an open thread; nothing renders without an active thread. */
export function ChatViewScreen({ state }: { readonly state: ChatViewState }) {
  const {
  activatePanelTerminalStable, activeProject, activeRightPanelSurface, activeTerminalLaunchContext,
  activeThread, activeThreadRef, activeThreadShell, activeWorkspaceRoot,
  addDroppedFilesToComposer, addDroppedFoldersToComposer, addPullRequestsSurfaceStable, addTerminalContextToDraftStable,
  addTerminalSurfaceStable, availableEditors, closePanelTerminalStable, closeRightPanelSurface,
  closeTerminalShortcutLabel, composerDraftTarget, configuredPreviewUrls, embedded,
  getShortcutContextStable, handleFilePendingChangeStable, inlineRightPanelOwnsTitleBar, keybindings,
  linkedThreadPullRequest, newTerminalShortcutLabel, openFileSurfaceStable, panelAnimationsActive,
  pendingFileSurfaceIds, pullRequestsCapabilityKnown, pullRequestsSurfaceAvailable, renderedRightPanelSurface,
  rightPanelMaximized, rightPanelOpen, sendPreviewAnnotationStable, serverProjection,
  setIsWorkspaceFileDragActive, shouldUsePlanSidebarSheet, sideChatParentPanel, splitPanelTerminalStable,
  splitPanelTerminalVerticalStable, splitTerminalShortcutLabel, splitTerminalVerticalShortcutLabel, supportsPullRequests,
  terminalUiState, threadPanelOpen, threadPanelPopoverHandle, threadPanelPresentation,
  toggleRightPanelMaximizedStable, toggleRightPanelStable, toggleTerminalVisibilityStable, toggleThreadPanelStable,
  visiblePullRequestCount, visiblePullRequests, workspaceMutationId,
  } = state;

  if (!activeThread) {
    return embedded ? null : <NoActiveThreadState />;
  }
  const rightPanelContent = activeThreadRef ? (
    <RightPanelSurfaceContent
      surface={renderedRightPanelSurface}
      activeSurfaceId={activeRightPanelSurface?.id ?? null}
      threadRef={activeThreadRef}
      environmentId={activeThread.environmentId}
      visible={rightPanelOpen}
      composerDraftTarget={composerDraftTarget}
      keybindings={keybindings}
      configuredPreviewUrls={configuredPreviewUrls}
      workspaceMutationId={workspaceMutationId}
      getShortcutContext={getShortcutContextStable}
      onSendAnnotation={sendPreviewAnnotationStable}
      onCloseSurface={closeRightPanelSurface}
      sideChatParentPanel={sideChatParentPanel}
      terminal={{
        launchContext: activeTerminalLaunchContext ?? null,
        keybindings,
        onAddTerminalContext: addTerminalContextToDraftStable,
        onSplitTerminal: splitPanelTerminalStable,
        onSplitTerminalVertical: splitPanelTerminalVerticalStable,
        onNewTerminal: addTerminalSurfaceStable,
        onActiveTerminalChange: activatePanelTerminalStable,
        onCloseTerminal: closePanelTerminalStable,
        splitShortcutLabel: splitTerminalShortcutLabel ?? undefined,
        splitVerticalShortcutLabel: splitTerminalVerticalShortcutLabel ?? undefined,
        newShortcutLabel: newTerminalShortcutLabel ?? undefined,
        closeShortcutLabel: closeTerminalShortcutLabel ?? undefined,
      }}
      pullRequest={{
        capabilityKnown: pullRequestsCapabilityKnown,
        supported: supportsPullRequests,
        projectId: activeThread.projectId,
        pullRequests: visiblePullRequests,
        linkedPullRequest: linkedThreadPullRequest,
        branchPullRequest: activeThreadShell?.branchPullRequest ?? activeThread.branchPullRequest,
        onBack:
          pullRequestsSurfaceAvailable && visiblePullRequestCount > 1
            ? addPullRequestsSurfaceStable
            : undefined,
      }}
      files={{
        projectName: activeProject?.title ?? null,
        workspaceRoot: activeWorkspaceRoot,
        availableEditors,
        pendingSurfaceIds: pendingFileSurfaceIds,
        onOpenFile: openFileSurfaceStable,
        onPendingChange: handleFilePendingChangeStable,
      }}
    />
  ) : null;
  const panelToggleControlProps = {
    terminalAvailable: activeProject !== null,
    terminalOpen: terminalUiState.terminalOpen,
    terminalShortcutLabel: shortcutLabelForCommand(keybindings, "terminal.toggle"),
    threadPanelOpen,
    threadPanelPresentation,
    threadPanelPopoverHandle,
    threadPanelShortcutLabel: shortcutLabelForCommand(keybindings, "threadPanel.toggle"),
    rightPanelAvailable: activeProject !== null,
    rightPanelOpen,
    rightPanelShortcutLabel: shortcutLabelForCommand(keybindings, "rightPanel.toggle"),
    onToggleTerminal: toggleTerminalVisibilityStable,
    onToggleThreadPanel: toggleThreadPanelStable,
    onToggleRightPanel: toggleRightPanelStable,
  } satisfies PanelLayoutControlsProps;
  const panelToggleControls = (
    <PanelLayoutControls
      {...panelToggleControlProps}
      showThreadPanelControl={!inlineRightPanelOwnsTitleBar}
    />
  );
  const threadPanelHeaderControl = <ThreadPanelHeaderControl {...panelToggleControlProps} />;
  const panelLayoutControls = (
    <WorkspaceTitlebarControls
      showMaximizeControl={!shouldUsePlanSidebarSheet}
      rightPanelOpen={rightPanelOpen}
      animationsActive={panelAnimationsActive}
      maximized={rightPanelMaximized}
      onToggleMaximized={toggleRightPanelMaximizedStable}
    >
      {panelToggleControls}
    </WorkspaceTitlebarControls>
  );
  const workspaceFileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: setIsWorkspaceFileDragActive,
    addFiles: addDroppedFilesToComposer,
    addFolders: addDroppedFoldersToComposer,
  });
  return (
    <FileMetadataThreadProvider
      threadRef={activeThreadRef}
      cwd={activeWorkspaceRoot}
      checkpoints={serverProjection?.checkpoints}
    >
      <ChatViewContent
        state={state}
        rightPanelContent={rightPanelContent}
        panelLayoutControls={panelLayoutControls}
        panelToggleControls={panelToggleControls}
        threadPanelHeaderControl={threadPanelHeaderControl}
        workspaceFileDropHandlers={workspaceFileDropHandlers}
      />
    </FileMetadataThreadProvider>
  );
}
