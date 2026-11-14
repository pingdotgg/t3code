import * as Dialog from "../../components/ui/Dialog";
import { useRememberThreadProject } from "./useRememberThreadProject";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { buildProjectThreadStartTurnInput } from "../../lib/projectThreadStartTurn";
import { useWorktreeSetup } from "./use-worktree-setup";
import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import { AppBar } from "../../components/ui/AppBar";
import {
  StackActions,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import * as Option from "effect/Option";
import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  ThreadId,
  type ProjectScript,
} from "@t3tools/contracts";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  projectScriptTerminalInput,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";
import { Platform } from "react-native";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnectionsReady } from "../../state/workspace";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { restoredNewTaskDraftKey } from "../../state/new-task-draft-key";
import { clearPendingThreadCreationOutcome } from "../../state/pending-thread-creation";
import { recoverFailedThreadDraft } from "../../state/recover-failed-thread-draft";
import { useEnvironmentQuery } from "../../state/query";
import { dismissGitActionResult, useGitActionProgress } from "../../state/use-vcs-action-state";
import { vcsEnvironment } from "../../state/vcs";
import { EmptyState } from "../../components/ui/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useThreadShell } from "../../state/entities";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { connectionTone } from "../connection/connectionTone";
import {
  useRemoteConnections,
  useRemoteConnectionStatus,
  useRemoteEnvironmentRuntime,
} from "../../state/use-remote-environment-registry";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { uuidv4 } from "../../lib/uuid";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useSelectedThreadDetailState } from "../../state/use-thread-detail";
import { useThreadSelection } from "../../state/use-thread-selection";
import { GitActionProgressOverlay } from "./GitActionProgressOverlay";
import {
  buildTerminalMenuSessions,
  nextOpenTerminalId,
  resolveProjectScriptTerminalId,
} from "../terminal/terminalMenu";
import {
  resolvePreferredThreadWorktreePath,
  stagePendingTerminalLaunch,
} from "../terminal/terminalLaunchContext";
import type { ThreadDetailScreenProps } from "./ThreadDetailScreen";
import { ThreadScreenBinding, ThreadScreenFallback, ThreadScreenHost } from "./ThreadScreenHost";
import { draftRouteIdentity } from "./thread-route-state";
import { NewTaskDraftRouteScreen, type NewTaskDraftRouteParams } from "./NewTaskDraftRouteScreen";
import { GitOverviewSheet } from "./git/GitOverviewSheet";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../state/use-selected-thread-git-state";
import { useSelectedThreadRequests } from "../../state/use-selected-thread-requests";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { resolveMergeBackTargetThreadId } from "@t3tools/client-runtime/state/thread-relationships";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import { threadEnvironment } from "../../state/threads";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import { useProjects } from "../../state/entities";
import { projectThreadContentPresentation } from "./threadContentPresentation";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
  useRegisterWorkspaceInspector,
} from "../layout/AdaptiveWorkspaceLayout";
import { ThreadFileNavigatorPane } from "../files/thread-file-navigator-pane";
import {
  ThreadInspectorContentStack,
  type ThreadInspectorMode,
} from "./thread-inspector-content-stack";
import {
  threadDetailErrorIsCurrent,
  threadRouteIsHydrating,
  threadRouteOpensDraft,
} from "./thread-route-hydration";
import { ThreadHeader } from "./ThreadHeader";
import { resumeThread } from "./resume-thread";
import {
  useAndroidWorkspaceBack,
  useWorkspaceBackNavigation,
} from "../workspace/useAndroidWorkspaceNavigation";
import { openSettings } from "../settings/settings-navigation";
import {
  InspectorContentScope,
  ThreadInspectorHeader,
  ThreadInspectorPreview,
  type ThreadInspectorPresentation,
} from "./thread-inspector-preview";
import type { ThreadInspectorTarget } from "./thread-inspector-navigation";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { LiveThreadRouteController } from "./ThreadRouteScreenParts";
import { firstRouteParam, ThreadRouteScreen, type ThreadRouteContentProps } from "./ThreadRouteScreen.tsx";

export function useThreadRouteContentController(props: ThreadRouteContentProps) {
  const { themeVariables } = useAppearancePreferences();
  const headerColor = themeVariables["--color-header"];
  const { fileInspector, layout, panes, showAuxiliaryPane, toggleAuxiliaryPane } =
    useAdaptiveWorkspaceLayout();
  const { connectionState } = useRemoteConnectionStatus();
  const { onReconnectEnvironment } = useRemoteConnections();
  const {
    selectedThread,
    selectedThreadCreation,
    selectedThreadDetailRef,
    selectedThreadProject,
    selectedEnvironmentConnection,
  } = useThreadSelection();
  useRememberThreadProject(selectedThreadProject);
  const canOperateThread = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const canReadTerminal = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthTerminalReadScope,
  );
  const canOperateTerminal = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthTerminalOperateScope,
  );
  const selectedThreadDetailState = props.selectedThreadDetailState;
  const selectedThreadDetail = Option.getOrNull(selectedThreadDetailState.data);
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const composer = useThreadComposerState();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const requests = useSelectedThreadRequests();
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, "thread interrupt");
  const resumeThreadQueue = useAtomCommand(threadEnvironment.resumeThreadQueue, {
    label: "resume queue",
    reportFailure: false,
  });
  const continueThreadRun = useAtomCommand(threadEnvironment.startTurn, {
    label: "continue thread",
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    label: "set thread runtime mode",
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    label: "set thread interaction mode",
    reportFailure: false,
  });
  const loadEarlierHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  const historyControls = (() => {
    const history = selectedThreadDetailState.history;
    if (!selectedThread) {
      return undefined;
    }
    if (!history.hasMoreHistory && history.error === null) {
      return undefined;
    }
    return {
      hasMoreHistory: history.hasMoreHistory,
      loading: history.loading,
      error: history.error,
      onLoadEarlier: () => {
        void loadEarlierHistory({
          environmentId: selectedThread.environmentId,
          input: { threadId: selectedThread.id },
        });
      },
      onLoadThrough: (throughEntryId: string) => {
        void loadEarlierHistory({
          environmentId: selectedThread.environmentId,
          input: { threadId: selectedThread.id, throughEntryId },
        });
      },
    };
  })();
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const openPullRequest = useOpenPullRequest();
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack, "merge thread back");
  const mergeBackTargetThreadId = resolveMergeBackTargetThreadId(selectedThreadDetail);
  const mergeBackRun =
    selectedThreadDetail === null ? null : resolveLatestMergeBackRun(selectedThreadDetail);
  const mergeBackBusyRef = useRef(false);
  const handleMergeBack = async () => {
    if (
      mergeBackBusyRef.current ||
      !selectedThread ||
      mergeBackTargetThreadId === null ||
      mergeBackRun === null
    ) {
      return;
    }
    mergeBackBusyRef.current = true;
    const result = await mergeBack({
      environmentId: selectedThread.environmentId,
      input: {
        sourceThreadId: selectedThread.id,
        targetThreadId: mergeBackTargetThreadId,
        runId: mergeBackRun.id,
        creationSource: "mobile",
      },
    });
    mergeBackBusyRef.current = false;
    if (result._tag !== "Success") return;
    selectDetail({
      name: "Thread",
      params: { environmentId: selectedThread.environmentId, threadId: mergeBackTargetThreadId },
    });
  };
  const params = props.route.params ?? {};
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const threadId = firstRouteParam(params.threadId);
  const routeThreadIdentity =
    environmentIdRaw !== null && threadId !== null ? `${environmentIdRaw}:${threadId}` : null;
  // The chosen mode survives thread switches; "route" only applies while the route
  // supplies an inspector, which is also the default whenever it does.
  const [chosenInspectorMode, setChosenInspectorMode] = useState<ThreadInspectorMode | null>(null);
  const previewTarget = props.inspectorPresentation ? undefined : params.inspector;
  const inspectorMode: ThreadInspectorMode | null = (() => {
    if (previewTarget) return "preview";
    const mode =
      props.renderInspector === undefined
        ? chosenInspectorMode === "route"
          ? null
          : chosenInspectorMode
        : chosenInspectorMode === null || chosenInspectorMode === "route"
          ? "route"
          : chosenInspectorMode;
    return mode === "files" && selectedThreadCwd === null ? null : mode;
  })();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the workspace navigator's auxiliary pane when the thread has no cwd for the file inspector
  useEffect(() => {
    if (
      props.inspectorPresentation === undefined &&
      fileInspector.supported &&
      selectedThreadCwd === null &&
      inspectorMode === null &&
      panes.auxiliaryPaneVisible
    ) {
      toggleAuxiliaryPane();
    }
  }, [
    fileInspector.supported,
    inspectorMode,
    panes.auxiliaryPaneVisible,
    props.inspectorPresentation,
    selectedThreadCwd,
    toggleAuxiliaryPane,
  ]);

  const revealPreview = useEffectEvent(() => showAuxiliaryPane("inspector"));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the workspace navigator's inspector pane when route params bring a preview target
  useEffect(() => {
    if (previewTarget) revealPreview();
  }, [previewTarget]);
  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const routeConnectionState =
    routeEnvironmentRuntime?.connectionState ?? (environmentId ? "available" : connectionState);
  const routeConnectionError = routeEnvironmentRuntime?.connectionError ?? null;
  const selectedThreadWithDraftSettings = selectedThread
    ? {
        ...selectedThread,
        modelSelection: composer.modelSelection ?? selectedThread.modelSelection,
        runtimeMode: composer.runtimeMode ?? selectedThread.runtimeMode,
        interactionMode: composer.interactionMode ?? selectedThread.interactionMode,
      }
    : null;

  const usesNativeHeaderGlass = NATIVE_LIQUID_GLASS_SUPPORTED;
  const delegatedFrom = selectedThread?.delegatedFrom ?? null;
  const delegatedFromRef =
    delegatedFrom === null
      ? null
      : scopeThreadRef(delegatedFrom.environmentId, delegatedFrom.threadId);
  // The title it had at delegation, until this client sees the parent itself.
  const delegatedFromThread = useThreadShell(delegatedFromRef);
  const headerSubtitle = [
    selectedThreadProject?.title ?? null,
    selectedEnvironmentConnection?.environmentLabel ?? null,
    // A linked environment's delegated task names its parent; other linked work its origin.
    delegatedFrom !== null
      ? `Subagent of ${delegatedFromThread?.title ?? delegatedFrom.title}`
      : selectedThread?.linkOrigin
        ? `From ${selectedThread.linkOrigin.label}`
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  const { sessions: knownTerminalSessions } = useKnownTerminalSessions({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
  const terminalMenuSessions = buildTerminalMenuSessions({
    knownSessions: knownTerminalSessions ?? [],
    workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
  });
  const selectedThreadDetailWorktreePath = selectedThreadDetail?.thread.worktreePath ?? null;
  const handleReconnectEnvironment = () => {
    if (!environmentId) {
      return;
    }
    onReconnectEnvironment(environmentId);
  };

  const gitActionProgressTarget = {
    environmentId: selectedThread?.environmentId ?? null,
    cwd: selectedThreadCwd,
  };
  const gitActionProgress = useGitActionProgress(gitActionProgressTarget);

  const handleOpenGitInspector = () => {
    if (!fileInspector.supported) {
      if (selectedThread === null) {
        return;
      }
      navigation.navigate("GitOverview", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
      });
      return;
    }
    navigation.setParams({ inspector: undefined });
    setChosenInspectorMode("git");
    showAuxiliaryPane("inspector");
  };
  const handleOpenFilesInspector = () => {
    if (selectedThread === null || selectedThreadCwd === null) {
      return;
    }
    if (!fileInspector.supported) {
      navigation.navigate("ThreadFiles", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
      });
      return;
    }
    navigation.setParams({ inspector: undefined });
    setChosenInspectorMode(props.renderInspector === undefined ? "files" : "route");
    showAuxiliaryPane("inspector");
  };
  const handleToggleInspector = () => {
    if (inspectorMode === null) {
      handleOpenFilesInspector();
      return;
    }
    toggleAuxiliaryPane();
  };
  const handleSelectInspectorFile = (path: string) => {
    if (selectedThread === null) {
      return;
    }
    const params = {
      environmentId: String(selectedThread.environmentId),
      threadId: String(selectedThread.id),
      path: path.split("/").filter((segment) => segment.length > 0),
    };
    if (fileInspector.supported) {
      navigation.navigate("ThreadFile", params);
      return;
    }
    navigation.navigate("ThreadFile", params);
  };
  const safeAreaInsets = useSafeAreaInsets();
  const inspectorHeaderInset = Platform.OS === "ios" ? 0 : safeAreaInsets.top;
  const renderGitInspector = () => (
    <GitOverviewSheet
      headerInset={inspectorHeaderInset}
      presentation="inspector"
      route={{ params: { environmentId: environmentId!, threadId: threadId! } }}
    />
  );
  const renderFilesInspector = () =>
    selectedThread !== null && selectedThreadCwd !== null ? (
      <ThreadFileNavigatorPane
        cwd={selectedThreadCwd}
        environmentId={selectedThread.environmentId}
        headerInset={inspectorHeaderInset}
        projectName={selectedThreadProject?.title ?? "Files"}
        selectedPath={null}
        onSelectFile={handleSelectInspectorFile}
      />
    ) : null;
  const renderRouteInspector = () => props.renderInspector?.(inspectorHeaderInset);
  const renderPreviewInspector = () =>
    previewTarget && panes.auxiliaryPaneVisible ? (
      <ThreadInspectorPreview
        target={previewTarget}
        renderThread={(screen) => <ThreadRouteScreen {...screen} />}
        onClose={toggleAuxiliaryPane}
        onOpen={(inspector) => {
          if (
            inspector.type === "thread" &&
            inspector.environmentId === environmentId &&
            inspector.threadId === threadId
          ) {
            toggleAuxiliaryPane();
            return;
          }
          navigation.setParams({ inspector });
        }}
      />
    ) : null;
  const renderInspectorStack = () =>
    inspectorMode === null ? null : (
      <ThreadInspectorContentStack
        renderPreview={renderPreviewInspector}
        renderFiles={renderFilesInspector}
        renderGit={renderGitInspector}
        mode={inspectorMode}
        resetKeys={[routeThreadIdentity, selectedThreadCwd]}
        renderRoute={props.renderInspector ? renderRouteInspector : undefined}
      />
    );
  const activeInspectorRenderer =
    props.inspectorPresentation || inspectorMode === null ? undefined : renderInspectorStack;
  useRegisterWorkspaceInspector(activeInspectorRenderer);

  const handleOpenConnectionEditor = () => {
    void navigation.navigate("Connections");
  };

  return {
    headerColor,
    fileInspector,
    layout,
    connectionState,
    onReconnectEnvironment,
    selectedThread,
    selectedThreadCreation,
    selectedThreadDetailRef,
    selectedThreadProject,
    selectedEnvironmentConnection,
    canOperateThread,
    canReadTerminal,
    canOperateTerminal,
    selectedThreadDetailState,
    selectedThreadDetail,
    selectedThreadCwd,
    composer,
    gitState,
    gitActions,
    requests,
    interruptThreadTurn,
    resumeThreadQueue,
    continueThreadRun,
    setThreadRuntimeMode,
    setThreadInteractionMode,
    historyControls,
    navigation,
    openPullRequest,
    mergeBackTargetThreadId,
    mergeBackRun,
    handleMergeBack,
    environmentIdRaw,
    environmentId,
    threadId,
    routeThreadIdentity,
    inspectorMode,
    routeEnvironmentRuntime,
    routeConnectionState,
    routeConnectionError,
    selectedThreadWithDraftSettings,
    usesNativeHeaderGlass,
    headerSubtitle,
    gitStatus,
    knownTerminalSessions,
    terminalMenuSessions,
    selectedThreadDetailWorktreePath,
    handleReconnectEnvironment,
    gitActionProgress,
    handleOpenGitInspector,
    handleOpenFilesInspector,
    handleToggleInspector,
    activeInspectorRenderer,
    handleOpenConnectionEditor,
  };
}
