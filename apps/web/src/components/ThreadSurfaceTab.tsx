import type { SideChatParentPanel } from "~/lib/sideChatPane";
import { useSideChat } from "./chat/useSideChat";
import { threadEnvironment } from "../state/threads";
import { DEFAULT_RUNTIME_MODE } from "../types";
/** Resolve surface context independently of ChatView so tabs remain usable after the chat closes,
 * and report when their thread is gone. */
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { msg, T, useGT, useMessages } from "gt-react";
import {
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type EnvironmentId,
  type IssueTrackerKind,
  type PreviewAnnotationPayload,
  type PreviewSessionSnapshot,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { orchestrationV2WorktreePending } from "@t3tools/shared/orchestrationV2ThreadError";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabelsCopy";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { FolderX, Unlink2Icon } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";

import { isBrowserSettingsReadError } from "../browser/openFileInPreview";
import { previewRuntimeTabId } from "../browser/previewRuntimeTabId";
import { type ComposerImageAttachment, useComposerDraftStore } from "../composerDraftStore";
import { useDiffPanelStore } from "../diffPanelStore";
import { isElectron } from "../env";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { getClientSettings, useEnvironmentSettings } from "../hooks/useSettings";
import { useLayoutPane } from "../layout/layoutPaneContext";
import { copyLayoutFilePath } from "../layout/PaneTabs";
import type { LauncherSurfaceKind } from "./SurfaceLauncher";
import { THREAD_TERMINAL_SURFACE_ID } from "../layout/layoutModel";
import { terminalTabTitle } from "../layout/surfaceTabLabels";
import { runInNewLayoutTab } from "../layout/layoutStore";
import {
  useThreadChatBridge,
  useThreadChatBridgeStore,
  waitForThreadChatSendReady,
} from "../layout/threadSurfaceBridge";
import { showThreadChatBeside } from "../layout/openRules";
import { requestLayoutSurfacePlacement } from "../layout/surfaceSync";
import { shortcutLabelForCommand } from "../keybindings";
import { readLocalApi } from "../localApi";
import { randomUUID } from "../lib/utils";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { browserMiniPlayerSource } from "../previewMiniPlayerStore";
import {
  isPreviewSupportedInRuntime,
  readThreadPreviewState,
  setActivePreviewTab,
  useThreadPreviewState,
} from "../previewStateStore";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "../rightPanelStore";
import {
  readThreadShell,
  useAllEnvironmentShellsBootstrapped,
  useEnvironmentSupportsServerBrowser,
  useProject,
  useServerConfigs,
  useQuietThreadShell,
  useQuietThreadProjection,
} from "../state/entities";
import { deviceEnvironment } from "../state/device";
import { previewEnvironment } from "../state/preview";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../state/server";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentSessionStatus,
} from "../state/session";
import { terminalEnvironment } from "../state/terminal";
import { knownTerminalSessionsAtom, useKnownTerminalSessions } from "../state/terminalSessions";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentQuery } from "../state/query";
import { focusActivePanelTerminal, focusTerminal } from "../lib/terminalFocus";
import { requestSideChatComposerFocus } from "../lib/workspaceFocus";
import { sideThreadComposer, sideThreadKindOf } from "@t3tools/client-runtime/side-thread";
import { useOpenSurfaceInMainView } from "../hooks/useOpenSurfaceInMainView";
import type { TerminalContextSelection } from "../lib/terminalContext";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import {
  isThreadlessSurfacesRef,
  threadlessSurfacesProjectRef,
  useThreadlessHome,
} from "../threadlessSurfaces";
import { findProjectForChangeRequest } from "@t3tools/client-runtime/change-request-links";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { MAX_TERMINALS_PER_GROUP } from "../types";
import { agentControlledBrowserCloseConfirmation } from "./ChatView.logic";
import { FileSurfaceState } from "./files/fileSurfaceChrome";
import { addBrowserSurface } from "./preview/addBrowserSurface";
import { floatPanelSurfaceOnClose } from "./preview/agentOpenedPreviews";
import { closePreviewSession } from "./preview/closePreviewSession";
import { getConfiguredPreviewUrls } from "./preview/previewEmptyStateLogic";
import { PullRequestDetailGhost } from "./pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "./pullRequest/PullRequestsUnavailableState";
import { IssueDetailGhost } from "./issue/IssueDetailGhost";
import { IssueGlyph } from "./issue/issuePresentation";
import {
  pullRequestPanelContext,
  threadPullRequestPanelTarget,
} from "./pullRequest/pullRequestDetail.logic";
import { ThreadPullRequestsPanel } from "./pullRequest/ThreadPullRequestsPanel";
import { RightPanelTabs } from "./RightPanelTabs";
import {
  PersistentThreadTerminalDrawer,
  PersistentThreadTerminalPanel,
} from "./ThreadTerminalSurfaces";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { m } from "../i18n/messages";
import { confirmTerminalClose } from "../lib/terminalCloseConfirm";

// Not lazy: revealing a suspended tiptap editor tears down its view and crashes the composer.
const SideThreadPane = lazy(() => import("./chat/SideThreadPane"));
const LinkedThreadPane = lazy(() =>
  import("./chat/LinkedThreadPane").then((module) => ({ default: module.LinkedThreadPane })),
);
const PreviewPanel = lazy(() =>
  import("./preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const DiffPanel = lazy(() => import("./DiffPanel"));
const DevicePanel = lazy(() =>
  import("./device/DevicePanel").then((module) => ({ default: module.DevicePanel })),
);
const FilePreviewPanel = lazy(() => import("./files/FilePreviewPanel"));
const PullRequestDetailPanel = lazy(() =>
  import("./pullRequest/PullRequestDetailPanel").then((module) => ({
    default: module.PullRequestDetailPanel,
  })),
);
const IssueDetailPanel = lazy(() =>
  import("./issue/IssueDetailPanel").then((module) => ({ default: module.IssueDetailPanel })),
);

const EMPTY_PENDING: ReadonlySet<string> = new Set();
const noop = () => undefined;

/** What a thread's surfaces work in: its project, checkout and capabilities. */
function useThreadSurfaceContext(threadRef: ScopedThreadRef) {
  const serverThread = useQuietThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const draftId = useComposerDraftStore((store) => store.getDraftIdByRef(threadRef));
  const environmentId = threadRef.environmentId;
  const threadless = isThreadlessSurfacesRef(threadRef);
  const projectId =
    serverThread?.projectId ??
    draftThread?.projectId ??
    threadlessSurfacesProjectRef(threadRef)?.projectId ??
    null;
  const projectRef = projectId === null ? null : scopeProjectRef(environmentId, projectId);
  const project = useProject(projectRef);
  const settings = useEnvironmentSettings(environmentId);
  const projectScripts = project ? resolveProjectScripts(settings, project) : [];
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  // Without a project, a threadless ref works in the server's home.
  const home = useThreadlessHome(threadRef);
  const workspaceRoot = worktreePath ?? project?.workspaceRoot ?? home;
  const gitCwd = project
    ? projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath })
    : home;
  const serverConfig = useServerConfigs().get(environmentId) ?? null;
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const isServerThread = serverThread !== null;
  return {
    serverThread,
    draftThread,
    isServerThread,
    threadless,
    project,
    projectScripts,
    worktreePath,
    workspaceRoot,
    gitCwd,
    serverConfig,
    projectRef,
    // A threadless surface has no composer, so nothing to comment into.
    composerDraftTarget: threadless
      ? undefined
      : isServerThread
        ? threadRef
        : (draftId ?? threadRef),
    // A threadless ref is gone with its project; one without a project never is.
    gone:
      bootstrapped &&
      (threadless
        ? projectId !== null && project === null
        : serverThread === null && draftThread === null),
  };
}

/**
 * What a thread can open as a surface, and how: the launcher's rows and a
 * surface tab's "+". Each opens through `rightPanelStore`, and the layout
 * gives it a tab (surfaceSync.ts).
 */
export function useThreadSurfaceOpeners(threadRef: ScopedThreadRef) {
  const gt = useGT();
  const ref = threadRef;
  const context = useThreadSurfaceContext(ref);
  const canOperatePreview = useEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope);
  const sessionStatus = useEnvironmentSessionStatus(threadRef.environmentId);
  const canOperateTerminal = useEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope);
  const serverBrowser = useEnvironmentSupportsServerBrowser(threadRef.environmentId);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const allocateTerminalId = useTerminalIdAllocator(ref);
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const canOperateThread = useEnvironmentScope(
    threadRef.environmentId,
    AuthOrchestrationOperateScope,
  );
  const projection = useQuietThreadProjection(threadRef)?.projection;
  const sideChat = useSideChat({
    threadRef:
      canOperateThread &&
      context.serverThread !== null &&
      context.serverThread.lineage.sideChat !== true &&
      context.serverThread.lineage.relationshipToParent !== "subagent" &&
      context.serverThread.delegatedFrom === null &&
      !orchestrationV2WorktreePending(context.worktreePath, projection?.runs ?? []) &&
      context.serverConfig?.environment.capabilities.sideChats === true
        ? threadRef
        : null,
    // No composer here, so the side chat takes the parent's saved mode and model.
    readSettings: () => ({
      runtimeMode: context.serverThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      modelSelection: context.serverThread?.modelSelection,
    }),
    onError: (description) =>
      toastManager.add({ type: "error", title: gt("Could not open side chat"), description }),
  });
  const serverConfigLoaded = context.serverConfig !== null;
  const shell = context.serverThread;
  const threadPullRequestTarget =
    shell && serverConfigLoaded
      ? threadPullRequestPanelTarget({
          projectId: shell.projectId,
          pullRequests: shell.pullRequests,
          linkedPullRequest: shell.linkedPullRequest,
          branchPullRequest: shell.branchPullRequest,
        })
      : null;
  // A threadless ref's pull request is the one for its project checkout's branch.
  const projectStatus = useEnvironmentQuery(
    context.threadless && context.gitCwd !== null && serverConfigLoaded
      ? vcsEnvironment.status({
          environmentId: threadRef.environmentId,
          input: { cwd: context.gitCwd },
        })
      : null,
  );
  const pullRequestTarget =
    threadPullRequestTarget ??
    projectPullRequestTarget(
      context.project,
      projectStatus.data?.pr?.url ?? null,
      serverConfigLoaded,
    );
  const linkedCount = visibleThreadPullRequests(shell?.pullRequests ?? []).length;
  // Why the browser cannot open here: each case its own reason.
  const browserUnavailableReason =
    sessionStatus === "Initial"
      ? gt("Connecting to the environment.")
      : sessionStatus === "Failure"
        ? gt("Can't reach the environment.")
        : !canOperatePreview
          ? gt("Ask the environment owner for preview access.")
          : isPreviewSupportedInRuntime() || serverBrowser
            ? null
            : gt("Only available in the desktop app.");
  const available: Record<LauncherSurfaceKind, boolean> = {
    browser: browserUnavailableReason === null,
    terminal: context.gitCwd !== null && canOperateTerminal,
    files: context.workspaceRoot !== null,
    // Outside a Git repository it opens on its empty state.
    diff: (context.isServerThread || context.threadless) && context.gitCwd !== null,
    "pull-request": pullRequestTarget !== null,
    "pull-requests":
      context.isServerThread &&
      serverConfigLoaded &&
      (linkedCount > 0 || (shell?.issues?.length ?? 0) > 0),
    device: true,
    "side-chat": sideChat.available,
  };
  const open = (
    kind: LauncherSurfaceKind,
    browserProfileId?: string,
    duplicateFrom?: PreviewSessionSnapshot,
  ) => {
    if (!available[kind]) return;
    const store = useRightPanelStore.getState();
    switch (kind) {
      case "side-chat":
        void sideChat.open();
        return;
      case "diff":
        // A project checkout opens on its uncommitted changes; a thread on its branch's.
        useDiffPanelStore
          .getState()
          .selectGitScope(threadRef, context.threadless ? "unstaged" : "branch");
        store.open(threadRef, "diff");
        return;
      case "files":
        store.open(threadRef, "files");
        return;
      case "pull-requests":
        store.open(threadRef, "pull-requests");
        return;
      case "device":
        store.open(threadRef, "device");
        return;
      case "pull-request":
        if (pullRequestTarget) store.openPullRequest(threadRef, pullRequestTarget);
        return;
      case "browser":
        void addBrowserSurface({
          threadRef,
          openPreview,
          ...(browserProfileId === undefined ? {} : { profileId: browserProfileId }),
          ...(duplicateFrom === undefined ? {} : { duplicateFrom }),
        }).then((result) => {
          if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
          const error = squashAtomCommandFailure(result);
          if (isBrowserSettingsReadError(error)) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: gt("Unable to open browser"),
                description: error.message,
              }),
            );
          }
        });
        return;
      case "terminal": {
        if (!readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)) return;
        const terminalId = allocateTerminalId();
        const input = terminalOpenInput(threadRef, terminalId, context);
        if (input === null) return;
        store.openTerminal(threadRef, terminalId);
        focusTerminal(threadRef, terminalId);
        void openTerminal({ environmentId: threadRef.environmentId, input });
        return;
      }
    }
  };
  const runShellCommand = (command: string) => {
    if (!readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)) return;
    const terminalId = allocateTerminalId();
    const input = terminalOpenInput(threadRef, terminalId, context);
    if (input === null) return;
    useRightPanelStore.getState().openTerminal(threadRef, terminalId);
    focusTerminal(threadRef, terminalId);
    void openTerminal({ environmentId: threadRef.environmentId, input }).then((result) => {
      if (result._tag !== "Success") return;
      return writeTerminal({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          terminalId,
          data: `${command}\n`,
        },
      });
    });
  };
  return {
    available,
    browserUnavailableReason,
    pullRequestNumber: pullRequestTarget?.number ?? null,
    linkedPullRequestCount: linkedCount,
    open,
    runShellCommand,
  };
}

/** A new shell in a surface's folder: its checkout, or the server's home. */
function terminalOpenInput(
  threadRef: ScopedThreadRef,
  terminalId: string,
  context: ReturnType<typeof useThreadSurfaceContext>,
) {
  const { gitCwd, project, worktreePath } = context;
  if (gitCwd === null) return null;
  return {
    threadId: threadRef.threadId,
    terminalId,
    cwd: gitCwd,
    ...(worktreePath != null ? { worktreePath } : {}),
    ...(project
      ? { env: projectScriptRuntimeEnv({ project: { cwd: project.workspaceRoot }, worktreePath }) }
      : {}),
  };
}

/**
 * A project checkout's branch pull request as a surface target, the way a
 * link to it opens one; null when its URL is not this project's repository.
 */
function projectPullRequestTarget(
  project: EnvironmentProject | null,
  url: string | null,
  threadPullRequests: boolean,
) {
  if (!project || url === null) return null;
  const link = sourceControlClients.parseChangeRequestUrl(url)?.link;
  if (!link || !findProjectForChangeRequest([project], link)) return null;
  return {
    projectId: project.id,
    ...(threadPullRequests ? { host: link.authority ?? link.host } : {}),
    repository: threadPullRequests
      ? link.repository
      : (sourceControlClients.repositorySelector(project.repositoryIdentity) ?? link.repository),
    number: link.number,
    url,
  };
}

/** A terminal id the thread has not used, as ChatView picks them. */
function useTerminalIdAllocator(threadRef: ScopedThreadRef): () => string {
  const known = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const drawerIds = useTerminalUiStateStore(
    (state) => selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef).terminalIds,
  );
  const panelSurfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );
  return () => {
    const ids = new Set<string>(drawerIds);
    for (const session of known ?? []) {
      if (session.target.threadId === threadRef.threadId) ids.add(session.target.terminalId);
    }
    for (const surface of panelSurfaces) {
      if (surface.kind === "terminal") for (const id of surface.terminalIds) ids.add(id);
    }
    const canReuse =
      known !== null && readEnvironmentScope(threadRef.environmentId, AuthTerminalReadScope);
    return nextTerminalId([...ids], canReuse ? undefined : randomUUID());
  };
}

/** The terminal keys' labels for its tooltips (new, close), as a focused terminal hears them. */
function useTerminalShortcutLabels() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const options = { context: { terminalFocus: true, terminalOpen: true } };
  const label = (command: "terminal.new" | "terminal.close") =>
    shortcutLabelForCommand(keybindings, command, options) ?? undefined;
  return {
    newShortcutLabel: label("terminal.new"),
    closeShortcutLabel: label("terminal.close"),
  };
}

function useTerminalLabels(threadRef: ScopedThreadRef): ReadonlyMap<string, string> {
  const messages = useMessages();
  const known = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const labels = new Map<string, string>();
  for (const session of known ?? []) {
    if (session.target.threadId !== threadRef.threadId) continue;
    labels.set(
      session.target.terminalId,
      resolveTerminalSessionLabel(session.target.terminalId, session.state.summary, messages),
    );
  }
  return labels;
}

/** A surface tab: the thread's terminal, or one of its `rightPanelStore` surfaces. */
export function ThreadSurfaceTab({
  threadRef,
  surfaceId,
}: {
  threadRef: ScopedThreadRef;
  surfaceId: string;
}) {
  if (surfaceId === THREAD_TERMINAL_SURFACE_ID) return <ThreadTerminalTab threadRef={threadRef} />;
  return <ThreadSurfacePane threadRef={threadRef} surfaceId={surfaceId} />;
}

function ThreadTerminalTab({ threadRef }: { threadRef: ScopedThreadRef }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const bridge = useThreadChatBridge(threadRef);
  const shortcutLabels = useTerminalShortcutLabels();
  const { paneId } = useLayoutPane();
  return (
    <PersistentThreadTerminalDrawer
      threadRef={threadRef}
      threadId={threadRef.threadId}
      active
      launchContext={bridge?.terminalLaunchContext ?? null}
      {...shortcutLabels}
      keybindings={keybindings}
      onAddTerminalContext={
        isThreadlessSurfacesRef(threadRef)
          ? undefined
          : (selection) => addTerminalContextFromChat(threadRef, paneId, selection)
      }
      paneMode
    />
  );
}

/** The linked thread stays discoverable in a surface tab's tooltip. */
function useThreadTitle(threadRef: ScopedThreadRef): string | null {
  const shell = useQuietThreadShell(threadRef);
  const draft = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const gt = useGT();
  return shell?.title ?? (draft ? gt("New thread") : null);
}

function ThreadSurfacePane({
  threadRef,
  surfaceId,
}: {
  threadRef: ScopedThreadRef;
  surfaceId: string;
}) {
  const surface = useRightPanelStore(
    (state) =>
      selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces.find(
        (candidate) => candidate.id === surfaceId,
      ) ?? null,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const context = useThreadSurfaceContext(threadRef);
  const openers = useThreadSurfaceOpeners(threadRef);
  const previewState = useThreadPreviewState(threadRef);
  const terminalLabels = useTerminalLabels(threadRef);
  const threadTitle = useThreadTitle(threadRef);
  const { visible, paneId } = useLayoutPane();
  const handleNewThread = useNewThreadHandler();
  const openInMainView = useOpenSurfaceInMainView(threadRef);
  const { projectRef } = context;
  const add = (
    kind: LauncherSurfaceKind,
    browserProfileId?: string,
    duplicateFrom?: PreviewSessionSnapshot,
  ) => {
    if (paneId !== null && openers.available[kind]) {
      requestLayoutSurfacePlacement(threadRef, { kind: "pane", paneId });
    }
    openers.open(kind, browserProfileId, duplicateFrom);
  };
  const getShortcutContext = () => ({
    terminalFocus: false,
    terminalOpen: false,
    previewFocus: false,
    previewOpen: surface?.kind === "preview",
    isWeb: !isElectron,
    isDesktop: isElectron,
  });
  const resolveRuntimeTabId = (tabId: string) =>
    previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId);
  // A browser tab shown makes its preview the thread's active one.
  const previewResourceId = surface?.kind === "preview" ? surface.resourceId : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the external preview store active tab aligned with the visible layout surface.
  useEffect(() => {
    if (visible && previewResourceId) setActivePreviewTab(threadRef, previewResourceId);
  }, [previewResourceId, threadRef, visible]);
  if (!surface) return null;
  const close = () => void closeThreadSurface(threadRef, surface.id);
  return (
    <RightPanelTabs
      mode="embedded"
      open
      keybindings={keybindings}
      surfaces={[surface]}
      environmentId={threadRef.environmentId}
      activeSurfaceId={surface.id}
      pendingSurfaceIds={EMPTY_PENDING}
      previewSessions={previewState.sessions}
      desktopByTabId={previewState.desktopByTabId}
      previewRuntimeTabId={resolveRuntimeTabId}
      terminalLabelsById={terminalLabels}
      threadTitle={threadTitle}
      onActivate={(active) => {
        // Choosing a side chat's tab puts the keyboard in its message box, even when it shows.
        // A thread with no composer, or one not known yet, takes focus as any other tab does.
        const kind =
          active.kind === "thread"
            ? sideThreadKindOf(
                readThreadShell(scopeThreadRef(threadRef.environmentId, active.threadId)),
              )
            : null;
        if (kind !== null && sideThreadComposer(kind) === "composer") {
          requestSideChatComposerFocus(threadRef, active.id);
        }
      }}
      onCloseSurface={close}
      onCloseSelectedSurfaces={noop}
      onOpenInMainView={openInMainView}
      onRenameDevice={(id, title) =>
        useRightPanelStore.getState().renameDevice(threadRef, id, title)
      }
      onCloseOtherSurfaces={noop}
      onCloseSurfacesToRight={noop}
      onCloseAllSurfaces={noop}
      onCopyFilePath={(path) => copyLayoutFilePath(threadRef, path)}
      onAddBrowser={() => add("browser")}
      onAddBrowserInProfile={(profileId) => add("browser", profileId)}
      onDuplicateBrowser={(tab) => {
        const snapshot =
          tab.kind === "preview" && tab.resourceId ? previewState.sessions[tab.resourceId] : null;
        if (snapshot) add("browser", undefined, snapshot);
      }}
      onNewThread={
        projectRef === null
          ? undefined
          : () => void runInNewLayoutTab(() => handleNewThread(projectRef))
      }
      onAddTerminal={() => add("terminal")}
      onAddDiff={() => add("diff")}
      onAddFiles={() => add("files")}
      onAddPullRequest={() => add("pull-request")}
      onAddPullRequests={() => add("pull-requests")}
      onAddDevice={() => add("device")}
      onAddSideChat={() => add("side-chat")}
      sideChatAvailable={openers.available["side-chat"]}
      browserAvailable={openers.available.browser}
      browserUnavailableReason={openers.browserUnavailableReason}
      terminalAvailable={openers.available.terminal}
      diffAvailable={openers.available.diff}
      filesAvailable={openers.available.files}
      pullRequestAvailable={openers.available["pull-request"]}
      pullRequestsAvailable={openers.available["pull-requests"]}
      deviceAvailable={openers.available.device}
    >
      {context.gone ? (
        <ThreadGoneState threadless={context.threadless} onClose={close} />
      ) : (
        <ThreadSurfaceContent
          threadRef={threadRef}
          surface={surface}
          context={context}
          visible={visible}
          openers={openers}
          openInPane={add}
          getShortcutContext={getShortcutContext}
        />
      )}
    </RightPanelTabs>
  );
}

function ThreadGoneState({ threadless, onClose }: { threadless: boolean; onClose: () => void }) {
  const gt = useGT();
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Unlink2Icon />
        </EmptyMedia>
        <EmptyTitle>{threadless ? gt("Its project is gone") : gt("Its thread is gone")}</EmptyTitle>
        <EmptyDescription>
          {threadless
            ? gt("The project this was opened in no longer exists.")
            : gt("The thread this was opened from no longer exists.")}
        </EmptyDescription>
        <div className="mt-4 flex justify-center">
          <Button size="sm" variant="secondary" onClick={onClose}>
            <T>Close tab</T>
          </Button>
        </div>
      </EmptyHeader>
    </Empty>
  );
}

function ThreadSurfaceContent({
  threadRef,
  surface,
  context,
  visible,
  openers,
  openInPane,
  getShortcutContext,
}: {
  threadRef: ScopedThreadRef;
  surface: RightPanelSurface;
  context: ReturnType<typeof useThreadSurfaceContext>;
  visible: boolean;
  openers: ReturnType<typeof useThreadSurfaceOpeners>;
  openInPane: (kind: LauncherSurfaceKind) => void;
  getShortcutContext: () => {
    terminalFocus: boolean;
    terminalOpen: boolean;
    previewFocus: boolean;
    previewOpen: boolean;
    isWeb: boolean;
    isDesktop: boolean;
  };
}) {
  const gt = useGT();
  const bridge = useThreadChatBridge(threadRef);
  const { paneId } = useLayoutPane();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors =
    useAtomValue(serverEnvironment.configValueAtom(threadRef.environmentId))?.availableEditors ??
    [];
  const workspaceMutationId = bridge?.workspaceMutationId ?? null;
  const [pendingFiles, setPendingFiles] = useState<ReadonlySet<string>>(EMPTY_PENDING);
  const onPendingChange = (relativePath: string, pending: boolean) => {
    setPendingFiles((current) => {
      const id = `file:${relativePath}`;
      if (current.has(id) === pending) return current;
      const next = new Set(current);
      if (pending) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const configuredUrls = getConfiguredPreviewUrls(context.projectScripts);
  const terminal = useTerminalSurfaceActions(threadRef, surface, context);
  const shortcutLabels = useTerminalShortcutLabels();
  const shell = context.serverThread;
  const sideChatParentPanel: SideChatParentPanel = {
    hostRef: threadRef,
    openToolDiff: (target) => {
      useDiffPanelStore.getState().selectToolCall(threadRef, target);
      useRightPanelStore.getState().open(threadRef, "diff");
    },
    runShellCommand: openers.runShellCommand,
  };

  switch (surface.kind) {
    case "thread":
      return (
        <Suspense fallback={null}>
          <SideThreadPane
            key={surface.id}
            parentRef={threadRef}
            surface={surface}
            parentPanel={sideChatParentPanel}
            onClose={() => void closeThreadSurface(threadRef, surface.id)}
          />
        </Suspense>
      );
    case "linked-thread":
      return (
        <Suspense fallback={null}>
          <LinkedThreadPane
            key={surface.id}
            panelRef={threadRef}
            surface={surface}
            visible={visible}
          />
        </Suspense>
      );
    case "preview":
      return (
        <Suspense fallback={null}>
          <PreviewPanel
            mode="embedded"
            threadRef={threadRef}
            tabId={surface.resourceId}
            configuredUrls={configuredUrls}
            visible={visible}
            // Annotations go to a chat; a threadless browser has none.
            {...(context.threadless
              ? {}
              : {
                  onSendAnnotation: (
                    annotation: PreviewAnnotationPayload,
                    image: ComposerImageAttachment | null,
                  ) => void sendAnnotationFromChat(threadRef, paneId, annotation, image),
                })}
          />
        </Suspense>
      );
    case "terminal":
      return (
        <PersistentThreadTerminalPanel
          visible={visible}
          threadRef={threadRef}
          surface={surface}
          launchContext={null}
          keybindings={keybindings}
          onAddTerminalContext={
            context.threadless
              ? undefined
              : (selection) => addTerminalContextFromChat(threadRef, paneId, selection)
          }
          onSplitTerminal={terminal.split}
          onSplitTerminalVertical={terminal.splitVertical}
          onNewTerminal={() => openInPane("terminal")}
          onActiveTerminalChange={terminal.activate}
          onCloseTerminal={terminal.close}
          {...shortcutLabels}
        />
      );
    case "diff":
      return (
        <Suspense fallback={null}>
          <DiffPanel
            visible={visible}
            mode="embedded"
            composerDraftTarget={context.composerDraftTarget}
            workspaceMutationId={bridge?.workspaceRevision ?? null}
            threadRef={context.isServerThread || context.threadless ? threadRef : null}
            projectRef={context.threadless ? context.projectRef : null}
            folder={context.threadless && !context.projectRef ? context.workspaceRoot : null}
          />
        </Suspense>
      );
    case "pull-request":
      if (!context.serverConfig) return <PullRequestDetailGhost />;
      return (
        <Suspense fallback={<PullRequestDetailGhost />}>
          <PullRequestDetailPanel
            key={`${surface.host ?? ""}:${surface.repository}#${surface.number}`}
            initialTab={surface.detailTab ?? "summary"}
            revealUrl={surface.revealUrl}
            onRevealSettled={(revealUrl) => {
              useRightPanelStore
                .getState()
                .settlePullRequestReveal(threadRef, surface.id, revealUrl);
            }}
            onTabChange={(tab) =>
              useRightPanelStore.getState().setPullRequestDetailTab(threadRef, surface.id, tab)
            }
            getShortcutContext={getShortcutContext}
            shortcutsEnabled={visible}
            environmentId={
              (surface.environmentId as EnvironmentId | undefined) ?? threadRef.environmentId
            }
            onSelectPullRequest={(reference) =>
              useRightPanelStore.getState().openPullRequest(threadRef, {
                ...(surface.environmentId === undefined
                  ? {}
                  : { environmentId: surface.environmentId }),
                projectId: reference.projectId,
                repository: reference.repository,
                number: reference.number,
                ...(reference.host ? { host: reference.host } : {}),
              })
            }
            threadRef={context.threadless ? null : threadRef}
            reference={{
              projectId: surface.projectId as ProjectId,
              ...(surface.host ? { host: surface.host } : {}),
              repository: surface.repository,
              number: surface.number,
            }}
            context={pullRequestPanelContext(
              {
                projectId: shell?.projectId ?? context.project?.id ?? null,
                pullRequests: visibleThreadPullRequests(shell?.pullRequests ?? []),
                linkedPullRequest: shell?.linkedPullRequest ?? null,
                branchPullRequest: shell?.branchPullRequest ?? null,
              },
              surface,
            )}
            // Threadless, its hand-offs start a thread, as the pull requests page's do.
            {...(context.composerDraftTarget
              ? { composerDraftTarget: context.composerDraftTarget }
              : {})}
            onBack={
              openers.available["pull-requests"] &&
              visibleThreadPullRequests(shell?.pullRequests ?? []).length > 1
                ? () => openInPane("pull-requests")
                : undefined
            }
          />
        </Suspense>
      );
    case "issue":
      if (!context.serverConfig) return <IssueDetailGhost />;
      if (context.serverConfig.environment.capabilities.issues !== true) {
        return (
          <PullRequestsUnavailableState
            icon={IssueGlyph.issue}
            title={gt("Issues unavailable")}
            error={gt("Update this environment's T3 Code server to browse issues.")}
          />
        );
      }
      return (
        <Suspense fallback={<IssueDetailGhost />}>
          <IssueDetailPanel
            key={`${surface.environmentId ?? threadRef.environmentId}:${surface.id}`}
            environmentId={
              (surface.environmentId as EnvironmentId | undefined) ?? threadRef.environmentId
            }
            reference={{
              projectId: surface.projectId as ProjectId,
              tracker: surface.tracker as IssueTrackerKind,
              ...(surface.host ? { host: surface.host } : {}),
              scope: surface.scope,
              key: surface.key,
            }}
            threadRef={context.threadless ? null : threadRef}
            onSelectPullRequest={(reference) =>
              useRightPanelStore.getState().openPullRequest(threadRef, {
                ...(surface.environmentId === undefined
                  ? {}
                  : { environmentId: surface.environmentId }),
                projectId: reference.projectId,
                repository: reference.repository,
                number: reference.number,
                ...(reference.host ? { host: reference.host } : {}),
              })
            }
            onSelectIssue={({ host, ...reference }) =>
              useRightPanelStore.getState().openIssue(threadRef, {
                ...(surface.environmentId === undefined
                  ? {}
                  : { environmentId: surface.environmentId }),
                ...reference,
                ...(host ? { host } : {}),
              })
            }
            // Back to the linked items, as a pull request among several goes back to them.
            {...(openers.available["pull-requests"] &&
            visibleThreadPullRequests(shell?.pullRequests ?? []).length +
              (shell?.issues?.length ?? 0) >
              1
              ? {
                  onBack: () => openInPane("pull-requests"),
                  backLabel: gt("Back to linked items"),
                }
              : {})}
          />
        </Suspense>
      );

    case "pull-requests":
      return <ThreadPullRequestsPanel threadRef={threadRef} />;
    case "device":
      return (
        <Suspense fallback={null}>
          <DevicePanel
            mode="embedded"
            threadRef={threadRef}
            key={surface.id}
            surface={surface}
            visible={visible}
          />
        </Suspense>
      );
    case "files":
    case "file": {
      const attachment = surface.kind === "file" ? surface.attachment : undefined;
      if (!context.workspaceRoot && !attachment) {
        return (
          <FileSurfaceState
            icon={<FolderX />}
            title={gt("No project folder")}
            description={gt("This thread has no workspace folder, so there are no files to show.")}
          />
        );
      }
      return (
        <Suspense fallback={null}>
          <FilePreviewPanel
            key={`${threadRef.environmentId}:${
              attachment ? `attachment:${attachment.id}` : context.workspaceRoot
            }`}
            environmentId={threadRef.environmentId}
            cwd={context.workspaceRoot ?? ""}
            // A worktree's root is its cwd; a project folder sits inside its repository.
            repositoryRoot={
              context.worktreePath ? undefined : context.project?.repositoryIdentity?.rootPath
            }
            projectName={context.project?.title ?? "~"}
            projectId={context.project?.id}
            threadRef={threadRef}
            composerDraftTarget={context.composerDraftTarget}
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInShortcutEnabled={visible}
            relativePath={surface.kind === "file" ? surface.relativePath : null}
            {...(attachment ? { attachment } : {})}
            revealLine={surface.kind === "file" ? (surface.revealLine ?? null) : null}
            revealRequestId={surface.kind === "file" ? surface.revealRequestId : 0}
            onOpenFile={(relativePath) =>
              useRightPanelStore.getState().openFile(threadRef, relativePath)
            }
            onNavigateFolder={(relativePath, folderTrail, keepSource) =>
              useRightPanelStore
                .getState()
                .navigateFolder(threadRef, surface.id, relativePath, folderTrail, keepSource)
            }
            folderTrail={surface.folderTrail}
            onPendingChange={onPendingChange}
            selectedFilePending={surface.kind === "file" && pendingFiles.has(surface.id)}
            workspaceMutationId={workspaceMutationId}
          />
        </Suspense>
      );
    }
  }
}

async function addTerminalContextFromChat(
  threadRef: ScopedThreadRef,
  paneId: string | null,
  selection: TerminalContextSelection,
): Promise<boolean> {
  let bridge = useThreadChatBridgeStore.getState().byThreadKey[scopedThreadKey(threadRef)] ?? null;
  if (!bridge) {
    showThreadChatBeside(threadRef, paneId);
    bridge = await waitForThreadChatSendReady(threadRef, 15_000);
  }
  if (bridge) {
    bridge.addTerminalContext(selection);
    return true;
  }
  toastManager.add({
    type: "error",
    title: m(msg("Could not add terminal output to chat")),
    description: m(
      msg("The chat is not ready. Your terminal selection is still available to add again."),
    ),
  });
  return false;
}

/**
 * Send a browser annotation the way the chat sends anything: from its
 * composer, which already holds the annotation. A closed chat opens beside
 * the browser first and sends once it can.
 */
async function sendAnnotationFromChat(
  threadRef: ScopedThreadRef,
  paneId: string | null,
  annotation: PreviewAnnotationPayload,
  image: ComposerImageAttachment | null,
): Promise<void> {
  const open = useThreadChatBridgeStore.getState().byThreadKey[scopedThreadKey(threadRef)];
  if (open) {
    open.sendAnnotation(annotation, image);
    return;
  }
  showThreadChatBeside(threadRef, paneId);
  const bridge = await waitForThreadChatSendReady(threadRef, 15_000);
  if (bridge) {
    bridge.sendAnnotation(annotation, image);
    return;
  }
  toastManager.add(
    stackedThreadToast({
      type: "info",
      title: m(msg("Annotation attached to draft")),
      description: m(msg("The chat could not send it yet. Send it from the chat.")),
    }),
  );
}

/** A terminal surface's own split, switch and close, as ChatView's panel had them. */
function useTerminalSurfaceActions(
  threadRef: ScopedThreadRef,
  surface: RightPanelSurface,
  context: ReturnType<typeof useThreadSurfaceContext>,
) {
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);
  const allocateTerminalId = useTerminalIdAllocator(threadRef);
  const canWrite = () => readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope);
  const split = (direction: "horizontal" | "vertical" = "horizontal") => {
    if (
      !canWrite() ||
      surface.kind !== "terminal" ||
      surface.terminalIds.length >= MAX_TERMINALS_PER_GROUP
    ) {
      return;
    }
    const terminalId = allocateTerminalId();
    const input = terminalOpenInput(threadRef, terminalId, context);
    if (input === null) return;
    useRightPanelStore.getState().splitTerminal(threadRef, surface.id, terminalId, direction);
    focusTerminal(threadRef, terminalId);
    void openTerminal({ environmentId: threadRef.environmentId, input });
  };
  return {
    split: () => split("horizontal"),
    splitVertical: () => split("vertical"),
    activate: (terminalId: string) => {
      if (surface.kind !== "terminal") return;
      useRightPanelStore.getState().activateTerminal(threadRef, surface.id, terminalId);
      focusTerminal(threadRef, terminalId);
    },
    close: (terminalId: string) => {
      if (!canWrite() || surface.kind !== "terminal") return;
      void closeTerminalMutation({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, terminalId, deleteHistory: true },
      }).then((result) => {
        if (
          result._tag === "Failure" &&
          !isAtomCommandInterrupted(result) &&
          readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)
        ) {
          return writeTerminal({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, terminalId, data: "exit\n" },
          });
        }
      });
      storeCloseTerminal(threadRef, terminalId);
      useRightPanelStore.getState().closeTerminal(threadRef, surface.id, terminalId);
      focusActivePanelTerminal(threadRef);
    },
  };
}

// Closing

type SurfaceCloser = (threadRef: ScopedThreadRef, surfaces: readonly RightPanelSurface[]) => void;
/** Registered by `ThreadSurfaceServices`: ends what closed surfaces ran. */
let surfaceServices: {
  cleanup: SurfaceCloser;
  endTerminals: (threadRef: ScopedThreadRef, terminalIds: readonly string[]) => void;
} | null = null;

function readTerminalTabTitles(
  threadRef: ScopedThreadRef,
  terminalIds: readonly string[],
): string[] {
  const sessions = readEnvironmentScope(threadRef.environmentId, AuthTerminalReadScope)
    ? appAtomRegistry.get(knownTerminalSessionsAtom(threadRef.environmentId, threadRef.threadId))
    : null;
  return terminalIds.map((terminalId) =>
    terminalTabTitle(
      terminalId,
      resolveTerminalSessionLabel(
        terminalId,
        sessions?.find((session) => session.target.terminalId === terminalId)?.state.summary,
        m,
      ),
      m,
    ),
  );
}

/** Terminal labels that closing this surface will end, or empty when no shell ends. */
export function terminalTitlesForThreadSurface(
  threadRef: ScopedThreadRef,
  surfaceId: string,
): string[] {
  if (!readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)) return [];
  if (surfaceId === THREAD_TERMINAL_SURFACE_ID) {
    const { terminalIds } = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      threadRef,
    );
    return readTerminalTabTitles(threadRef, terminalIds);
  }
  const surface = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  ).surfaces.find((candidate) => candidate.id === surfaceId);
  if (surface?.kind !== "terminal") return [];
  const titles = readTerminalTabTitles(threadRef, surface.terminalIds);
  return titles.length > 0 ? titles : [m(msg("Terminal"))];
}

/** Collect terminal tab labels for any panel or thread terminal surfaces in `surfaceIds`. */
export function readThreadSurfaceTerminalTitles(
  threadRef: ScopedThreadRef,
  surfaceIds: readonly string[],
): string[] {
  return surfaceIds.flatMap((surfaceId) => terminalTitlesForThreadSurface(threadRef, surfaceId));
}

/** Combined agent-controlled browser confirmation across one or more threads' surface tabs. */
export function agentControlledBrowserCloseConfirmationForThreads(
  entries: readonly {
    readonly threadRef: ScopedThreadRef;
    readonly surfaceIds: readonly string[];
  }[],
): string | null {
  const agentSurfaces: RightPanelSurface[] = [];
  const agentDesktopByTabId: Record<string, { controller: "agent" }> = {};
  for (const { threadRef, surfaceIds } of entries) {
    if (surfaceIds.length === 0) continue;
    const panelIds = new Set(surfaceIds.filter((id) => id !== THREAD_TERMINAL_SURFACE_ID));
    if (panelIds.size === 0) continue;
    const { desktopByTabId } = readThreadPreviewState(threadRef);
    const { surfaces } = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    );
    for (const surface of surfaces) {
      if (
        !panelIds.has(surface.id) ||
        surface.kind !== "preview" ||
        surface.resourceId === null ||
        desktopByTabId[surface.resourceId]?.controller !== "agent"
      ) {
        continue;
      }
      agentSurfaces.push(surface);
      agentDesktopByTabId[surface.resourceId] = { controller: "agent" };
    }
  }
  return agentControlledBrowserCloseConfirmation(agentSurfaces, agentDesktopByTabId);
}

/** Close a batch of surfaces belonging to one thread atomically via `rightPanelStore.closeSurfaces`. */
export async function closeThreadSurfaces(
  threadRef: ScopedThreadRef,
  surfaceIds: readonly string[],
  options: { bulk?: boolean; skipConfirm?: boolean; activeSurfaceId?: string | null } = {},
): Promise<void> {
  if (surfaceIds.length === 0) return;
  if (surfaceIds.length === 1) {
    await closeThreadSurface(threadRef, surfaceIds[0]!, options);
    return;
  }
  const hasThreadTerminal = surfaceIds.includes(THREAD_TERMINAL_SURFACE_ID);
  const panelIds = new Set(surfaceIds.filter((id) => id !== THREAD_TERMINAL_SURFACE_ID));
  const panelState = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  );
  const activeSurfaceId = options.activeSurfaceId ?? panelState.activeSurfaceId;
  const surfaces = panelState.surfaces.filter((candidate) => panelIds.has(candidate.id));
  if (surfaces.length > 0 && !options.skipConfirm) {
    const message = agentControlledBrowserCloseConfirmation(
      surfaces,
      readThreadPreviewState(threadRef).desktopByTabId,
    );
    if (message) {
      const confirmed = await readLocalApi()
        ?.dialogs.confirm(message, { variant: "destructive" })
        .catch(() => false);
      if (!confirmed) return;
    }
  }
  if (!options.bulk && !options.skipConfirm) {
    const [first, ...rest] = readThreadSurfaceTerminalTitles(threadRef, surfaceIds);
    if (first !== undefined && !(await confirmTerminalClose([first, ...rest]))) return;
  }
  if (surfaces.length > 0) {
    // Close the tabs before releasing sessions, which can prune the tabs during reconciliation.
    useRightPanelStore.getState().closeSurfaces(
      threadRef,
      surfaces.map((surface) => surface.id),
    );
    // The active tab's session closes last so reopening restores it first.
    const releaseOrder = surfaces.toSorted(
      (left, right) => Number(left.id === activeSurfaceId) - Number(right.id === activeSurfaceId),
    );
    surfaceServices?.cleanup(threadRef, releaseOrder);
  }
  if (hasThreadTerminal) {
    await closeThreadSurface(threadRef, THREAD_TERMINAL_SURFACE_ID, {
      ...options,
      bulk: true,
      skipConfirm: true,
    });
  }
}

/** Closing a surface ends its resources; cmd+J preserves the thread terminal's shells. */
export async function closeThreadSurface(
  threadRef: ScopedThreadRef,
  surfaceId: string,
  options: { bulk?: boolean; skipConfirm?: boolean } = {},
): Promise<void> {
  if (surfaceId === THREAD_TERMINAL_SURFACE_ID) {
    if (readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)) {
      const { terminalIds } = selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        threadRef,
      );
      const [first, ...rest] = readTerminalTabTitles(threadRef, terminalIds);
      if (first !== undefined) {
        if (
          !options.bulk &&
          !options.skipConfirm &&
          !(await confirmTerminalClose([first, ...rest]))
        ) {
          return;
        }
        surfaceServices?.endTerminals(threadRef, terminalIds);
      }
    }
    useTerminalUiStateStore.getState().setTerminalOpen(threadRef, false);
    return;
  }
  const surface = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  ).surfaces.find((candidate) => candidate.id === surfaceId);
  if (!surface) return;
  const finish = () => {
    useRightPanelStore.getState().closeSurface(threadRef, surface.id);
    surfaceServices?.cleanup(threadRef, [surface]);
  };
  if (surface.kind === "preview" && !options.skipConfirm) {
    const message = agentControlledBrowserCloseConfirmation(
      [surface],
      readThreadPreviewState(threadRef).desktopByTabId,
    );
    if (message) {
      const confirmed = await readLocalApi()
        ?.dialogs.confirm(message, { variant: "destructive" })
        .catch(() => false);
      if (!confirmed) return;
    }
    finish();
    return;
  }
  if (
    surface.kind === "terminal" &&
    !options.bulk &&
    !options.skipConfirm &&
    readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)
  ) {
    const [first = m(msg("Terminal")), ...rest] = readTerminalTabTitles(
      threadRef,
      surface.terminalIds,
    );
    if (!(await confirmTerminalClose([first, ...rest]))) return;
  }
  finish();
}

/**
 * Take a thread's surface tabs off the layout, its terminal tab included.
 * Nothing they run ends; alt+cmd+B and cmd+J bring them back.
 */
export function hideThreadSurfaceTabs(threadRef: ScopedThreadRef): void {
  useRightPanelStore.getState().close(threadRef);
  useTerminalUiStateStore.getState().setTerminalOpen(threadRef, false);
}

/**
 * Close every surface of a thread without asking, because the thread itself is
 * being discarded: browsers and terminals end, and its terminal tab hides.
 */
export function discardThreadSurfaces(threadRef: ScopedThreadRef): void {
  const { surfaces } = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  );
  surfaceServices?.cleanup(threadRef, surfaces);
  useRightPanelStore.getState().closeAllSurfaces(threadRef);
  useTerminalUiStateStore.getState().setTerminalOpen(threadRef, false);
}

/**
 * Hide a thread's surfaces (alt+cmd+B): when Auto-show floating preview is on,
 * a live browser or device on screen floats in its mini player instead of disappearing.
 */
export function hideThreadSurfaces(threadRef: ScopedThreadRef): void {
  const active = selectActiveRightPanelSurface(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  );
  const source =
    active?.kind === "preview" && active.resourceId
      ? browserMiniPlayerSource(active.resourceId)
      : active?.kind === "device" && active.target
        ? ({ kind: "device", ...active.target } as const)
        : null;
  if (source) {
    floatPanelSurfaceOnClose(threadRef, source, {
      autoShowFloatingPreview: getClientSettings().browserAutoShowFloatingPreview,
      previewState: readThreadPreviewState(threadRef),
      deviceState:
        source.kind === "device"
          ? AsyncResult.getOrElse(
              appAtomRegistry.get(
                deviceEnvironment.state({ environmentId: threadRef.environmentId, input: {} }),
              ),
              () => null,
            )
          : null,
    });
  }
  useRightPanelStore.getState().close(threadRef);
}

/**
 * Mounted once with the layout host: ends what closed surfaces ran (preview
 * sessions, terminal sessions) through this client's connections.
 */
export function ThreadSurfaceServices() {
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Register mounted surface resource closers with the external lifecycle registry.
  useEffect(() => {
    const end = (threadRef: ScopedThreadRef, terminalIds: readonly string[]) => {
      if (!readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)) return;
      for (const terminalId of terminalIds) {
        storeCloseTerminal(threadRef, terminalId);
        void closeTerminalMutation({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, terminalId, deleteHistory: true },
        }).then((result) => {
          if (
            result._tag === "Failure" &&
            !isAtomCommandInterrupted(result) &&
            readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)
          ) {
            return writeTerminal({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, terminalId, data: "exit\n" },
            });
          }
        });
      }
    };
    const closer: SurfaceCloser = (threadRef, surfaces) => {
      for (const surface of surfaces) {
        if (
          surface.kind === "thread" &&
          // Only a side chat the shell still lists is thrown away with its tab; a subagent belongs
          // to its parent's work, and an unlisted side chat is already deleted.
          readThreadShell(scopeThreadRef(threadRef.environmentId, surface.threadId))?.lineage
            .sideChat === true &&
          readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
        ) {
          void deleteThread({
            environmentId: threadRef.environmentId,
            input: { threadId: surface.threadId, onlyIfUnused: true },
          });
        }
        if (
          surface.kind === "preview" &&
          surface.resourceId &&
          readEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope)
        ) {
          void closePreviewSession({
            closePreview,
            snapshot: readThreadPreviewState(threadRef).sessions[surface.resourceId] ?? null,
            tabId: surface.resourceId,
            threadRef,
          });
        }
        if (
          surface.kind === "terminal" &&
          readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)
        ) {
          end(threadRef, surface.terminalIds);
        }
      }
    };
    const services = { cleanup: closer, endTerminals: end };
    surfaceServices = services;
    return () => {
      if (surfaceServices === services) surfaceServices = null;
    };
  }, [closePreview, closeTerminalMutation, storeCloseTerminal, writeTerminal, deleteThread]);
  return null;
}
