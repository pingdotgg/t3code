import type { SideChatParentPanel } from "~/lib/sideChatPane";
import { useSideChat } from "./chat/useSideChat";
import { threadEnvironment } from "../state/threads";
/** Resolve surface context independently of ChatView so tabs remain usable after the chat closes,
 * and report when their thread is gone. */
import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  orchestrationV2WorktreePending,
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type PreviewAnnotationPayload,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";
import { nextTerminalId, resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { FolderX, Unlink2Icon } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";

import { BrowserSettingsReadError } from "../browser/openFileInPreview";
import { previewRuntimeTabId } from "../browser/previewRuntimeTabId";
import { type ComposerImageAttachment, useComposerDraftStore } from "../composerDraftStore";
import { useDiffPanelStore } from "../diffPanelStore";
import { isElectron } from "../env";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useLayoutPane } from "../layout/layoutPaneContext";
import type { LauncherSurfaceKind } from "./SurfaceLauncher";
import { THREAD_TERMINAL_SURFACE_ID } from "../layout/layoutModel";
import { runInNewLayoutTab } from "../layout/layoutStore";
import {
  useThreadChatBridge,
  useThreadChatBridgeStore,
  waitForThreadChatSendReady,
} from "../layout/threadSurfaceBridge";
import { showThreadChatBeside } from "../layout/openRules";
import { shortcutLabelForCommand } from "../keybindings";
import { readLocalApi } from "../localApi";
import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { randomUUID } from "../lib/utils";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "../previewMiniPlayerStore";
import {
  isPreviewSupportedInRuntime,
  readThreadPreviewState,
  setActivePreviewTab,
  useThreadPreviewState,
} from "../previewStateStore";
import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "../rightPanelStore";
import {
  useAllEnvironmentShellsBootstrapped,
  useEnvironmentSupportsServerBrowser,
  useProject,
  useServerConfigs,
  useQuietThreadShell,
  useQuietThreadProjection,
} from "../state/entities";
import { previewEnvironment } from "../state/preview";
import { primaryServerAvailableEditorsAtom, primaryServerKeybindingsAtom } from "../state/server";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentSessionStatus,
} from "../state/session";
import { terminalEnvironment } from "../state/terminal";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import { useEnvironmentQuery } from "../state/query";
import { focusActivePanelTerminal, focusTerminal } from "../lib/terminalFocus";
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
import { closePreviewSession } from "./preview/closePreviewSession";
import { getConfiguredPreviewUrls } from "./preview/previewEmptyStateLogic";
import { PullRequestDetailGhost } from "./pullRequest/PullRequestGhosts";
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
import { confirmTerminalClose } from "../lib/terminalCloseConfirm";

const SideChatPane = lazy(() => import("./chat/SideChatPane"));
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
      context.serverThread.delegatedFrom === undefined &&
      !orchestrationV2WorktreePending(context.worktreePath, projection?.runs ?? []) &&
      context.serverConfig?.environment.capabilities.sideChats === true
        ? threadRef
        : null,
    onError: (description) =>
      toastManager.add({ type: "error", title: "Could not open side chat", description }),
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
      ? "Connecting to the environment."
      : sessionStatus === "Failure"
        ? "Can't reach the environment."
        : !canOperatePreview
          ? "Ask the environment owner for preview access."
          : isPreviewSupportedInRuntime() || serverBrowser
            ? null
            : "Only available in the desktop app.";
  const available: Record<LauncherSurfaceKind, boolean> = {
    browser: browserUnavailableReason === null,
    terminal: context.gitCwd !== null && canOperateTerminal,
    files: context.workspaceRoot !== null,
    // Outside a Git repository it opens on its empty state.
    diff: (context.isServerThread || context.threadless) && context.gitCwd !== null,
    "pull-request": pullRequestTarget !== null,
    "pull-requests": context.isServerThread && serverConfigLoaded && linkedCount > 0,
    device: true,
    "side-chat": sideChat.available,
  };
  const open = (kind: LauncherSurfaceKind, browserProfileId?: string) => {
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
  return { available, browserUnavailableReason, open, runShellCommand };
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

/** The terminal keys' labels for its tooltips (split, new, close), as a focused terminal hears them. */
function useTerminalShortcutLabels() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const options = { context: { terminalFocus: true, terminalOpen: true } };
  const label = (
    command: "terminal.split" | "terminal.splitVertical" | "terminal.new" | "terminal.close",
  ) => shortcutLabelForCommand(keybindings, command, options) ?? undefined;
  return {
    splitShortcutLabel: label("terminal.split"),
    splitVerticalShortcutLabel: label("terminal.splitVertical"),
    newShortcutLabel: label("terminal.new"),
    closeShortcutLabel: label("terminal.close"),
  };
}

function useTerminalLabels(threadRef: ScopedThreadRef): ReadonlyMap<string, string> {
  const known = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const labels = new Map<string, string>();
  for (const session of known ?? []) {
    if (session.target.threadId !== threadRef.threadId) continue;
    labels.set(
      session.target.terminalId,
      resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
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

/** The thread's title for a surface tab's label ("Diff · Fix login"). */
function useThreadTitle(threadRef: ScopedThreadRef): string | null {
  const shell = useQuietThreadShell(threadRef);
  const draft = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  return shell?.title ?? (draft ? "New thread" : null);
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
  const { visible } = useLayoutPane();
  const handleNewThread = useNewThreadHandler();
  const { projectRef } = context;
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
      onActivate={noop}
      onCloseSurface={close}
      onRenameDevice={(id, title) =>
        useRightPanelStore.getState().renameDevice(threadRef, id, title)
      }
      onCloseOtherSurfaces={noop}
      onCloseSurfacesToRight={noop}
      onCloseAllSurfaces={noop}
      onCopyFilePath={(path) =>
        void navigator.clipboard?.writeText(
          formatFilePathForClipboard(
            path,
            resolvePathLinkTarget(path, context.gitCwd ?? context.workspaceRoot ?? ""),
          ),
        )
      }
      onAddBrowser={() => openers.open("browser")}
      onAddBrowserInProfile={(profileId) => openers.open("browser", profileId)}
      onNewThread={
        projectRef === null
          ? undefined
          : () => void runInNewLayoutTab(() => handleNewThread(projectRef))
      }
      onAddTerminal={() => openers.open("terminal")}
      onAddDiff={() => openers.open("diff")}
      onAddFiles={() => openers.open("files")}
      onAddPullRequest={() => openers.open("pull-request")}
      onAddPullRequests={() => openers.open("pull-requests")}
      onAddDevice={() => openers.open("device")}
      onAddSideChat={() => openers.open("side-chat")}
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
          getShortcutContext={getShortcutContext}
        />
      )}
    </RightPanelTabs>
  );
}

function ThreadGoneState({ threadless, onClose }: { threadless: boolean; onClose: () => void }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Unlink2Icon />
        </EmptyMedia>
        <EmptyTitle>{threadless ? "Its project is gone" : "Its thread is gone"}</EmptyTitle>
        <EmptyDescription>
          {threadless
            ? "The project this was opened in no longer exists."
            : "The thread this was opened from no longer exists."}
        </EmptyDescription>
        <div className="mt-4 flex justify-center">
          <Button size="sm" variant="secondary" onClick={onClose}>
            Close tab
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
  getShortcutContext,
}: {
  threadRef: ScopedThreadRef;
  surface: RightPanelSurface;
  context: ReturnType<typeof useThreadSurfaceContext>;
  visible: boolean;
  openers: ReturnType<typeof useThreadSurfaceOpeners>;
  getShortcutContext: () => {
    terminalFocus: boolean;
    terminalOpen: boolean;
    previewFocus: boolean;
    previewOpen: boolean;
    isWeb: boolean;
    isDesktop: boolean;
  };
}) {
  const bridge = useThreadChatBridge(threadRef);
  const { paneId } = useLayoutPane();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
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
    openToolDiff: (target) => {
      useDiffPanelStore.getState().selectToolCall(threadRef, target);
      useRightPanelStore.getState().open(threadRef, "diff");
    },
    runShellCommand: openers.runShellCommand,
  };

  switch (surface.kind) {
    case "side-chat":
      return (
        <Suspense fallback={null}>
          <SideChatPane
            parentRef={threadRef}
            threadId={surface.threadId}
            parentPanel={sideChatParentPanel}
            onClose={() => void closeThreadSurface(threadRef, surface.id)}
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
          onNewTerminal={() => openers.open("terminal")}
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
            workspaceMutationId={workspaceMutationId}
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
            onTabChange={(tab) =>
              useRightPanelStore.getState().setPullRequestDetailTab(threadRef, surface.id, tab)
            }
            getShortcutContext={getShortcutContext}
            shortcutsEnabled={visible}
            environmentId={threadRef.environmentId}
            onSelectPullRequest={(reference) =>
              useRightPanelStore.getState().openPullRequest(threadRef, {
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
                ? () => openers.open("pull-requests")
                : undefined
            }
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
            onDismissSetup={() => void closeThreadSurface(threadRef, surface.id)}
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
            title="No project folder"
            description="This thread has no workspace folder, so there are no files to show."
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
    title: "Could not add terminal output to chat",
    description: "The chat is not ready. Your terminal selection is still available to add again.",
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
      title: "Annotation attached to draft",
      description: "The chat could not send it yet. Send it from the chat.",
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

/** Closing a surface cleans its resource; hiding the thread terminal preserves shells. Threadless
 * terminals and bulk closes end their shells. */
export async function closeThreadSurface(
  threadRef: ScopedThreadRef,
  surfaceId: string,
  options: { bulk?: boolean } = {},
): Promise<void> {
  if (surfaceId === THREAD_TERMINAL_SURFACE_ID) {
    // A threadless project's terminal has no chat whose cmd+J brings it
    // back: closing it ends its shells, as a terminal surface's close does.
    if (
      isThreadlessSurfacesRef(threadRef) &&
      readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)
    ) {
      const { terminalIds } = selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        threadRef,
      );
      const [first, ...rest] = terminalIds.map((terminalId) => getTerminalLabel(terminalId));
      if (first !== undefined) {
        if (!options.bulk && !(await confirmTerminalClose([first, ...rest]))) return;
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
    surfaceServices?.cleanup(threadRef, [surface]);
    useRightPanelStore.getState().closeSurface(threadRef, surface.id);
  };
  if (surface.kind === "preview") {
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
    readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)
  ) {
    const [first = getTerminalLabel(surface.activeTerminalId), ...rest] = surface.terminalIds.map(
      (terminalId) => getTerminalLabel(terminalId),
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
 * Hide a thread's surfaces (alt+cmd+B): a live browser or device on screen
 * floats in its mini player instead of disappearing.
 */
export function hideThreadSurfaces(threadRef: ScopedThreadRef): void {
  const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
  const active = state.surfaces.find((surface) => surface.id === state.activeSurfaceId);
  if (active?.kind === "preview" && active.resourceId) {
    usePreviewMiniPlayerStore
      .getState()
      .open(threadRef, browserMiniPlayerSource(active.resourceId));
  } else if (active?.kind === "device" && active.target) {
    usePreviewMiniPlayerStore.getState().open(threadRef, { kind: "device", ...active.target });
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
          surface.kind === "side-chat" &&
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
