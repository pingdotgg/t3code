import * as Dialog from "../../components/ui/Dialog";
import { useRememberThreadProject } from "./useRememberThreadProject";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { buildProjectThreadStartTurnInput } from "../../lib/projectThreadStartTurn";
import { useWorktreeSetup } from "./use-worktree-setup";
import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import {
  StackActions,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import {
  createContext,
  startTransition,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useConnectionsReady } from "../../state/workspace";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { restoredNewTaskDraftKey } from "../../state/new-task-draft-key";
import { clearPendingThreadCreationOutcome } from "../../state/pending-thread-creation";
import { recoverFailedThreadDraft } from "../../state/recover-failed-thread-draft";
import { useEnvironmentQuery } from "../../state/query";
import {
  dismissGitActionResult,
  useGitActionProgress,
  useVcsActionState,
} from "../../state/use-vcs-action-state";
import { vcsEnvironment } from "../../state/vcs";
import { EmptyState } from "../../components/ui/EmptyState";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useProject, useThreadShell } from "../../state/entities";
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
import { NewTaskDraftShellHeader } from "./DraftThreadHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { View } from "react-native";
import { GitOverviewSheet } from "./git/GitOverviewSheet";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadRequests } from "../../state/use-selected-thread-requests";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { resolveMergeBackTargetThreadId } from "@t3tools/client-runtime/state/thread-relationships";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import { threadEnvironment } from "../../state/threads";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import { useProjects } from "../../state/entities";
import { projectThreadContentPresentation } from "./threadContentPresentation";
import {
  Inspector,
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import { ThreadFileNavigatorPane } from "../files/thread-file-navigator-pane";
import { InspectorSheetContext } from "../layout/workspace-inspector-sheet";
import type { InspectorContent } from "../layout/inspector-panes";
import {
  threadDetailErrorIsCurrent,
  threadRouteIsHydrating,
  threadRouteOpensDraft,
} from "./thread-route-hydration";
import { ThreadHeader } from "./ThreadHeader";
import {
  threadGitControlsContentKey,
  threadGitControlsStructureKey,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";
import { threadOpenGitControls } from "./thread-open-chrome";
import { resumeThread } from "./resume-thread";
import { useAndroidWorkspaceBack } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { openSettings } from "../settings/settings-navigation";
import {
  InspectorContentScope,
  ThreadInspectorHeader,
  ThreadInspectorPreview,
  type ThreadInspectorPresentation,
} from "./thread-inspector-preview";
import { useStartSideChat } from "./useStartSideChat";
import type { ThreadInspectorMode, ThreadInspectorTarget } from "./thread-inspector-navigation";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";

function firstRouteParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first.trim().length === 0 ? null : first;
}

// The inspector pane's bar belongs to ThreadInspectorHeader; the fallback must not draw its own.
const InspectorHeaderShownContext = createContext(false);

function ThreadRouteFallbackLayout(props: {
  readonly children: ReactNode;
  readonly title?: string;
  readonly subtitle?: string;
  readonly environmentId?: string | null;
  readonly threadId?: string | null;
  readonly currentBranch?: string | null;
}) {
  const inspectorHeaderShown = use(InspectorHeaderShownContext);
  const environmentId = props.environmentId ?? "";
  const threadId = props.threadId ?? "";
  const header =
    inspectorHeaderShown || environmentId.length === 0 || threadId.length === 0 ? undefined : (
      <ThreadHeader
        title={props.title ?? ""}
        subtitle={props.subtitle ?? ""}
        gitControls={threadOpenGitControls({
          environmentId,
          threadId,
          currentBranch: props.currentBranch ?? null,
          hasWorkspace: false,
        })}
        hasThreadCwd={false}
        inspectorMode={null}
        onOpenFilesInspector={() => {}}
      />
    );
  return <ThreadScreenFallback header={header}>{props.children}</ThreadScreenFallback>;
}

type ThreadRouteScreenRouteProps = StaticScreenProps<{
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly draft?: NewTaskDraftRouteParams;
  readonly inspector?: ThreadInspectorTarget;
  readonly prompt?: string | string[];
}>;

interface ThreadRouteScreenProps extends ThreadRouteScreenRouteProps {
  readonly inspectorPresentation?: ThreadInspectorPresentation;
  readonly onReturnToThread?: () => void;
  readonly renderInspector?: () => ReactNode;
}

function ThreadUnavailableScreen(props: {
  readonly actionLabel: string;
  readonly onAction: () => void;
  readonly environmentId?: string | null;
  readonly threadId?: string | null;
}) {
  return (
    <ThreadRouteFallbackLayout
      environmentId={props.environmentId}
      threadId={props.threadId}
      title="Thread unavailable"
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          paddingHorizontal: 24,
          paddingVertical: 32,
        }}
        className="bg-screen flex-1 android:bg-transparent"
      >
        <EmptyState
          title="Thread unavailable"
          detail="This thread is not available in the current mobile snapshot."
          actionLabel={props.actionLabel}
          onAction={props.onAction}
        />
      </ScrollView>
    </ThreadRouteFallbackLayout>
  );
}

/** A thread that can't load opens a new task in its environment instead of a dead end. */
function UnavailableThreadDraftRedirect(props: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const projects = useProjects();
  const openDraft = useEffectEvent(() => {
    const project = projects.find((candidate) => candidate.environmentId === props.environmentId);
    navigation.dispatch(
      StackActions.replace("Thread", {
        draft: project
          ? {
              requestId: uuidv4(),
              environmentId: String(project.environmentId),
              projectId: String(project.id),
            }
          : { requestId: uuidv4() },
      }),
    );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- replaces this route with a new draft thread route for the environment's project on mount
  useEffect(() => {
    openDraft();
  }, []);
  return <ThreadScreenFallback>{null}</ThreadScreenFallback>;
}

/**
 * First paint is the same ThreadHeader chrome as live (reserved menus/actions) so
 * promoting the body does not shift the bar. Body promotes after the push frame.
 */
function ThreadOpenShell(props: {
  readonly environmentId: string | null;
  readonly threadId: string | null;
  readonly hideHeader: boolean;
}) {
  const { fileInspector } = useWorkspacePaneState();
  const environmentId =
    props.environmentId !== null ? EnvironmentId.make(props.environmentId) : null;
  const threadRef =
    environmentId !== null && props.threadId !== null
      ? scopeThreadRef(environmentId, ThreadId.make(props.threadId))
      : null;
  const shell = useThreadShell(threadRef);
  const project = useProject(shell ? scopeProjectRef(shell.environmentId, shell.projectId) : null);
  // Prefer empty shell chrome over hydrating title/subtitle churn during open settle.
  const title = shell?.title ?? "";
  const subtitle = "";
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const hasWorkspace = Boolean(project?.workspaceRoot);
  const statusCwd = shell?.worktreePath ?? project?.workspaceRoot ?? null;
  // Keep the open shell free of git/terminal queries — live chrome hydrates menus after first paint.
  const gitControls = threadOpenGitControls({
    environmentId: props.environmentId ?? "",
    threadId: props.threadId ?? "",
    currentBranch: shell?.branch ?? null,
    hasWorkspace,
    canOperateTerminal,
    canOpenFiles: hasWorkspace,
  });
  const menuKeyInput = {
    ...gitControls,
    hasFilesInspector: statusCwd !== null,
    hasMergeBack: false,
  };
  // Structure only — content keys would retarget menus as cwd/branch hydrate.
  const structureKey = threadGitControlsStructureKey(menuKeyInput);
  const contentKey = structureKey;
  const navigation = useNavigation();
  const openFilesFromShell = useEffectEvent(() => {
    if (props.environmentId === null || props.threadId === null || statusCwd === null) return;
    // Shell may outlive the first tap; push the files route until live chrome owns the inspector.
    navigation.navigate("ThreadFiles", {
      environmentId: props.environmentId,
      threadId: props.threadId,
    });
  });
  if (props.hideHeader || props.environmentId === null || props.threadId === null) {
    return <ThreadScreenFallback>{null}</ThreadScreenFallback>;
  }
  return (
    <ThreadScreenFallback
      header={
        <ThreadHeader
          title={title}
          subtitle={subtitle}
          gitControls={gitControls}
          hasThreadCwd={statusCwd !== null}
          inspectorMode={null}
          onOpenFilesInspector={openFilesFromShell}
        />
      }
      headerKey={[
        "thread",
        "shell",
        props.environmentId,
        props.threadId,
        title,
        subtitle,
        structureKey,
        contentKey,
        fileInspector.supported ? "1" : "0",
        "",
        "0",
      ]}
    >
      {null}
    </ThreadScreenFallback>
  );
}

function NewTaskOpenShell() {
  return (
    <ThreadScreenFallback header={<NewTaskDraftShellHeader />} headerKey={["new-task", "chrome"]}>
      <View className="flex-1">
        <View className="flex-1 items-center justify-center gap-2 px-6">
          <Text className="text-center text-2xl font-t3-medium tracking-tight text-foreground">
            What should we build?
          </Text>
          <Text className="text-center text-foreground-muted">Tap below to start typing</Text>
        </View>
        <View className="gap-2 p-4 pb-1">
          <View className="min-h-16 justify-center rounded-2xl bg-grouped-card px-4 py-3">
            <Text className="text-foreground-muted">Ask anything</Text>
          </View>
        </View>
      </View>
    </ThreadScreenFallback>
  );
}

function DraftThreadRouteController(props: {
  readonly draft: NonNullable<ThreadRouteScreenProps["route"]["params"]>["draft"] & object;
  readonly route: ThreadRouteScreenProps["route"];
}) {
  const draftIdentity = draftRouteIdentity(props.draft);
  const [bodyReadyIdentity, setBodyReadyIdentity] = useState<string | null>(null);
  const bodyReady = bodyReadyIdentity === draftIdentity;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- defers NewTaskDraftRouteScreen until the open shell can settle
  useEffect(() => {
    let cancelled = false;
    let secondFrame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        timer = setTimeout(() => {
          if (cancelled) return;
          startTransition(() => {
            setBodyReadyIdentity(draftIdentity);
          });
        }, 200);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [draftIdentity]);
  if (!bodyReady) {
    return <NewTaskOpenShell />;
  }
  return (
    <NewTaskDraftRouteScreen key={draftIdentity} route={{ ...props.route, params: props.draft }} />
  );
}

export function ThreadRouteScreen(props: ThreadRouteScreenProps) {
  const draft = props.route.params?.draft;
  return (
    <ThreadScreenHost>
      {draft ? (
        <DraftThreadRouteController draft={draft} route={props.route} />
      ) : (
        // One controller owns the open shell → live promote so the shell is not remounted mid-push.
        <LiveThreadRouteController {...props} />
      )}
    </ThreadScreenHost>
  );
}

function LiveThreadRouteController(props: ThreadRouteScreenProps) {
  useAndroidWorkspaceBack("threads");
  const connectionsReady = useConnectionsReady();
  const { connectionState } = useRemoteConnectionStatus();
  const { selectedThread } = useThreadSelection();
  const params = props.route.params ?? {};
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const threadIdRaw = firstRouteParam(params.threadId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const routeEnvironmentShellState = useEnvironmentShellReadiness(environmentId);
  const { onReconnectEnvironment } = useRemoteConnections();
  const navigation = useNavigation();
  const routeName = useRoute().name;
  const routeConnectionState =
    routeEnvironmentRuntime?.connectionState ?? (environmentId ? "available" : connectionState);
  const routeThreadKey =
    environmentId !== null && threadIdRaw !== null
      ? scopedThreadKey(environmentId, ThreadId.make(threadIdRaw))
      : null;
  const selectedThreadKey =
    selectedThread === null
      ? null
      : scopedThreadKey(selectedThread.environmentId, selectedThread.id);
  const selectedThreadDetailState = useSelectedThreadDetailState();
  const detailError = selectedThreadDetailState.error;
  const [errorBeforeConnected, setErrorBeforeConnected] = useState(() =>
    routeConnectionState === "connected" ? Option.none<string>() : detailError,
  );
  if (routeConnectionState !== "connected" && errorBeforeConnected !== detailError) {
    setErrorBeforeConnected(detailError);
  }
  const [bodyReadyIdentity, setBodyReadyIdentity] = useState<string | null>(null);
  const bodyReady = bodyReadyIdentity === routeThreadKey && routeThreadKey !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- defers ThreadRouteContent until after the open shell paints; re-arms per thread
  useEffect(() => {
    if (routeThreadKey === null) return;
    let cancelled = false;
    let secondFrame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Long enough for settle-quiet 50ms to close on the open shell before the feed cliff.
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        timer = setTimeout(() => {
          if (cancelled) return;
          startTransition(() => {
            setBodyReadyIdentity(routeThreadKey);
          });
        }, 200);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [routeThreadKey]);
  const withInspectorHeader = (content: ReactNode) =>
    props.inspectorPresentation ? (
      <InspectorHeaderShownContext value>
        <ThreadInspectorHeader
          title={selectedThread?.title ?? "Thread"}
          {...props.inspectorPresentation}
        />
        {content}
      </InspectorHeaderShownContext>
    ) : (
      content
    );

  const openingScreen = (
    <ThreadOpenShell
      environmentId={environmentIdRaw}
      threadId={threadIdRaw}
      hideHeader={Boolean(props.inspectorPresentation)}
    />
  );

  if (environmentId === null || threadIdRaw === null) {
    return withInspectorHeader(openingScreen);
  }

  if (selectedThread !== null && selectedThreadKey === routeThreadKey) {
    if (!bodyReady) {
      return withInspectorHeader(openingScreen);
    }
    return withInspectorHeader(
      <ThreadRouteContent {...props} selectedThreadDetailState={selectedThreadDetailState} />,
    );
  }

  const stillHydrating = threadRouteIsHydrating({
    isLoadingConnections: !connectionsReady,
    environmentRegistered: routeEnvironmentRuntime !== null,
    localCacheRead:
      routeEnvironmentShellState.cacheRead &&
      selectedThreadDetailState !== EMPTY_ENVIRONMENT_THREAD_STATE,
    connectionState: routeConnectionState,
    shellStatus: routeEnvironmentShellState.status,
    shellHasError: routeEnvironmentShellState.hasError,
    detailStatus: selectedThreadDetailState.status,
    detailHasError: threadDetailErrorIsCurrent({
      connectionState: routeConnectionState,
      error: detailError,
      errorBeforeConnected,
    }),
  });

  if (stillHydrating) {
    return withInspectorHeader(openingScreen);
  }

  if (
    routeName === "Thread" &&
    !props.inspectorPresentation &&
    threadRouteOpensDraft({
      connectionState: routeConnectionState,
      detailStatus: selectedThreadDetailState.status,
    })
  ) {
    return <UnavailableThreadDraftRedirect environmentId={environmentId} />;
  }

  return withInspectorHeader(
    <ThreadUnavailableScreen
      environmentId={environmentIdRaw}
      threadId={threadIdRaw}
      actionLabel={
        routeEnvironmentRuntime === null ? "Manage environments" : "Reconnect environment"
      }
      onAction={() => {
        if (routeEnvironmentRuntime !== null) {
          onReconnectEnvironment(environmentId);
          return;
        }
        openSettings(navigation, "SettingsEnvironments");
      }}
    />,
  );
}

function ThreadRouteContent(
  props: ThreadRouteScreenProps & {
    readonly selectedThreadDetailState: ReturnType<typeof useSelectedThreadDetailState>;
  },
) {
  const { layout, showInspector, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const { fileInspector } = useWorkspacePaneState();
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
  const canOperateTerminal = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthTerminalOperateScope,
  );
  const selectedThreadDetailState = props.selectedThreadDetailState;
  const selectedThreadDetail = Option.getOrNull(selectedThreadDetailState.data);
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const startSideChat = useStartSideChat();
  const composer = useThreadComposerState({ startSideChat });
  const params = props.route.params ?? {};
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const threadId = firstRouteParam(params.threadId);
  const routeThreadIdentity =
    environmentIdRaw !== null && threadId !== null ? `${environmentIdRaw}:${threadId}` : null;
  // Git/terminal queries compete with first feed paint; reset per thread so switches defer again.
  const [chromeReadyIdentity, setChromeReadyIdentity] = useState<string | null>(null);
  const chromeReady = chromeReadyIdentity === routeThreadIdentity && routeThreadIdentity !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- defers git/terminal chrome until this thread's first paint has committed
  useEffect(() => {
    if (routeThreadIdentity === null) return;
    startTransition(() => {
      setChromeReadyIdentity(routeThreadIdentity);
    });
  }, [routeThreadIdentity]);
  // Label-only: full branch/discovery queries stay in git sheets, not the open path.
  const gitActionState = useVcsActionState({
    environmentId: chromeReady ? (selectedThread?.environmentId ?? null) : null,
    cwd: chromeReady ? selectedThreadCwd : null,
  });
  const gitActions = useSelectedThreadGitActions({ enabled: chromeReady });
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
  // The chosen mode survives thread switches; "route" only applies while the route
  // supplies an inspector, which is also the default whenever it does.
  const [chosenInspectorMode, setChosenInspectorMode] = useState<ThreadInspectorMode | null>(null);
  const previewTarget = props.inspectorPresentation ? undefined : params.inspector;
  const inspectorMode = (() => {
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
  const revealPreview = useEffectEvent(() => showInspector());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the workspace navigator's inspector pane when route params bring a preview target
  useEffect(() => {
    if (previewTarget) revealPreview();
  }, [previewTarget]);
  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const routeConnectionState =
    routeEnvironmentRuntime?.connectionState ?? (environmentId ? "available" : connectionState);
  const routeConnectionError = routeEnvironmentRuntime?.connectionError ?? null;
  // Keep the shell reference when the composer is not overlaying draft settings so
  // ThreadScreenBinding's body fingerprint stays stable across controller ticks.
  const selectedThreadWithDraftSettings =
    selectedThread === null
      ? null
      : composer.modelSelection !== null ||
          composer.runtimeMode !== null ||
          composer.interactionMode !== null
        ? {
            ...selectedThread,
            modelSelection: composer.modelSelection ?? selectedThread.modelSelection,
            runtimeMode: composer.runtimeMode ?? selectedThread.runtimeMode,
            interactionMode: composer.interactionMode ?? selectedThread.interactionMode,
          }
        : selectedThread;

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
  // Read-only menu hydration — do not wait on chromeReady (git actions). Early status
  // keeps the first UIMenu tree from rebuilding under the user's first tap.
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

  const handleOpenGitInspector = useEffectEvent(() => {
    navigation.setParams({ inspector: undefined });
    setChosenInspectorMode("git");
    showInspector();
  });
  const handleOpenFilesInspector = useEffectEvent(() => {
    if (selectedThread === null || selectedThreadCwd === null) {
      return;
    }
    navigation.setParams({ inspector: undefined });
    setChosenInspectorMode(props.renderInspector === undefined ? "files" : "route");
    showInspector();
  });
  const handleSelectInspectorFile = (path: string) => {
    if (selectedThread === null) {
      return;
    }
    const params = {
      environmentId: String(selectedThread.environmentId),
      threadId: String(selectedThread.id),
      path: path.split("/").filter((segment) => segment.length > 0),
    };
    navigation.navigate("ThreadFile", params);
  };
  const renderGitInspector = () => (
    <GitOverviewSheet
      presentation="inspector"
      route={{ params: { environmentId: environmentId!, threadId: threadId! } }}
    />
  );
  const renderFilesInspector = () =>
    selectedThread !== null && selectedThreadCwd !== null ? (
      <InspectorSheetContext.Consumer>
        {(closeInspectorSheet) => (
          <ThreadFileNavigatorPane
            cwd={selectedThreadCwd}
            environmentId={selectedThread.environmentId}
            projectName={selectedThreadProject?.title ?? "Files"}
            selectedPath={null}
            onSelectFile={(path) =>
              closeInspectorSheet
                ? closeInspectorSheet(() => handleSelectInspectorFile(path))
                : handleSelectInspectorFile(path)
            }
          />
        )}
      </InspectorSheetContext.Consumer>
    ) : null;
  const renderPreviewInspector = () =>
    previewTarget ? (
      <ThreadInspectorPreviewWhileVisible
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
  const inspectorContent: InspectorContent | null =
    inspectorMode === null
      ? null
      : {
          active: inspectorMode,
          resetKeys: [routeThreadIdentity, selectedThreadCwd],
          panes: [
            ...(inspectorMode === "preview"
              ? [
                  {
                    key: "preview",
                    render: renderPreviewInspector,
                  },
                ]
              : []),
            { key: "files", render: renderFilesInspector, prewarm: true },
            { key: "git", render: renderGitInspector, prewarm: true },
            ...(props.renderInspector ? [{ key: "route", render: props.renderInspector }] : []),
          ],
        };

  const handleOpenConnectionEditor = () => {
    void navigation.navigate("Connections");
  };
  const handleStopThread = () => {
    if (
      !selectedThread ||
      !readEnvironmentScope(selectedThread.environmentId, AuthOrchestrationOperateScope) ||
      composer.interruptibleRunId === null
    ) {
      return;
    }
    return interruptThreadTurn({
      environmentId: selectedThread.environmentId,
      input: {
        threadId: selectedThread.id,
        runId: composer.interruptibleRunId,
      },
    });
  };

  const handleResumeQueue = async () => {
    if (!selectedThread) return;
    const result = await resumeThread({
      thread: selectedThread,
      resumableRunId: composer.resumableRunId,
      queueHeld: composer.queueHeld,
      runtimeMode: composer.runtimeMode ?? selectedThread.runtimeMode,
      interactionMode: composer.interactionMode ?? selectedThread.interactionMode,
      modelSelection: composer.modelSelection,
      messageId: MessageId.make(uuidv4()),
      createdAt: new Date().toISOString(),
      setRuntimeMode: setThreadRuntimeMode,
      setInteractionMode: setThreadInteractionMode,
      startTurn: continueThreadRun,
      resumeQueue: resumeThreadQueue,
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not resume thread",
        error instanceof Error ? error.message : "Try again.",
      );
    }
  };

  const handleOpenTerminal = useEffectEvent((nextTerminalId?: string | null) => {
    if (
      !selectedThread ||
      !selectedThreadProject?.workspaceRoot ||
      (!readEnvironmentScope(selectedThread.environmentId, AuthTerminalReadScope) &&
        !readEnvironmentScope(selectedThread.environmentId, AuthTerminalOperateScope))
    ) {
      return;
    }

    void navigation.navigate("ThreadTerminal", {
      environmentId: String(selectedThread.environmentId),
      threadId: String(selectedThread.id),
      ...(nextTerminalId ? { terminalId: nextTerminalId } : {}),
    });
  });

  const handleOpenNewTerminal = useEffectEvent(() => {
    if (
      !selectedThread ||
      !selectedThreadProject?.workspaceRoot ||
      !readEnvironmentScope(selectedThread.environmentId, AuthTerminalOperateScope)
    ) {
      return;
    }

    const nextId = nextOpenTerminalId({
      listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
      ...(knownTerminalSessions === null ||
      !readEnvironmentScope(selectedThread.environmentId, AuthTerminalReadScope)
        ? { uniqueSuffix: uuidv4() }
        : {}),
    });
    void navigation.navigate("ThreadTerminal", {
      environmentId: String(selectedThread.environmentId),
      threadId: String(selectedThread.id),
      terminalId: nextId,
    });
  });

  const handleRunProjectScript = useEffectEvent(async (script: ProjectScript) => {
    if (
      !selectedThread ||
      !selectedThreadProject?.workspaceRoot ||
      !readEnvironmentScope(selectedThread.environmentId, AuthTerminalOperateScope)
    ) {
      return;
    }

    const targetTerminalId = resolveProjectScriptTerminalId({
      existingTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
      ...(knownTerminalSessions === null ||
      !readEnvironmentScope(selectedThread.environmentId, AuthTerminalReadScope)
        ? { uniqueSuffix: uuidv4() }
        : {}),
      hasRunningTerminal: terminalMenuSessions.some(
        (session) => session.status === "running" || session.status === "starting",
      ),
    });
    const preferredWorktreePath = resolvePreferredThreadWorktreePath({
      threadShellWorktreePath: selectedThread.worktreePath ?? null,
      threadDetailWorktreePath: selectedThreadDetailWorktreePath,
    });
    const cwd = projectScriptCwd({
      project: { cwd: selectedThreadProject.workspaceRoot },
      worktreePath: preferredWorktreePath,
    });
    const env = projectScriptRuntimeEnv({
      project: { cwd: selectedThreadProject.workspaceRoot },
      worktreePath: preferredWorktreePath,
    });
    stagePendingTerminalLaunch({
      target: {
        environmentId: selectedThread.environmentId,
        threadId: selectedThread.id,
        terminalId: targetTerminalId,
      },
      launch: {
        cwd,
        worktreePath: preferredWorktreePath,
        env,
        initialInput: projectScriptTerminalInput(script.command),
        stopOnSettle: script.stopOnSettle ?? false,
      },
    });

    void navigation.navigate("ThreadTerminal", {
      environmentId: String(selectedThread.environmentId),
      threadId: String(selectedThread.id),
      terminalId: targetTerminalId,
    });
  });
  const handleMergeBackPress = useEffectEvent(() => {
    void handleMergeBack();
  });
  const onPullSelectedThreadBranch = useEffectEvent(() => gitActions.onPullSelectedThreadBranch());
  const onRunSelectedThreadGitAction = useEffectEvent(
    (input: Parameters<ThreadGitControlsProps["onRunAction"]>[0]) =>
      gitActions.onRunSelectedThreadGitAction(input),
  );
  const projectScripts = selectedThreadProject
    ? resolveProjectScripts(
        routeEnvironmentRuntime?.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
        selectedThreadProject,
      )
    : [];
  // Keep the terminal menu mounted whenever the project has a root — scopes only disable items.
  const canOpenTerminal = Boolean(selectedThreadProject?.workspaceRoot);
  const canOpenFiles = Boolean(selectedThreadProject?.workspaceRoot);
  const hasMergeBack = mergeBackTargetThreadId !== null && mergeBackRun !== null;
  const hasFilesInspector = selectedThreadCwd !== null;
  const gitMenuInput = {
    environmentId: environmentIdRaw ?? "",
    threadId: threadId ?? "",
    currentBranch: selectedThread?.branch ?? null,
    gitStatus: gitStatus.data,
    gitOperationLabel: gitActionState.currentLabel,
    canOpenTerminal,
    canOperateTerminal,
    canOpenFiles,
    projectScripts,
    terminalSessions: terminalMenuSessions,
    hasFilesInspector,
    hasMergeBack,
  };
  const gitStructureKey = threadGitControlsStructureKey(gitMenuInput);
  const gitContentKey = threadGitControlsContentKey(gitMenuInput);
  // Folder selected state can lag; publishing it in headerKey races the Files sheet open.
  const [publishedInspectorMode, setPublishedInspectorMode] = useState<ThreadInspectorMode | null>(
    inspectorMode,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- defers folder-selected header republish until after the Files sheet presents
  useEffect(() => {
    if (publishedInspectorMode === inspectorMode) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        setPublishedInspectorMode(inspectorMode);
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [inspectorMode, publishedInspectorMode]);
  const threadGitControlProps: ThreadGitControlsProps = {
    environmentId: environmentIdRaw ?? "",
    threadId: threadId ?? "",
    onOpenFilesInspector: hasFilesInspector ? handleOpenFilesInspector : undefined,
    onOpenGitInspector: handleOpenGitInspector,
    onMergeBack: hasMergeBack ? handleMergeBackPress : undefined,
    currentBranch: selectedThread?.branch ?? null,
    gitStatus: gitStatus.data,
    gitOperationLabel: gitActionState.currentLabel,
    canOpenTerminal,
    canOperateTerminal,
    canOpenFiles,
    projectScripts,
    terminalSessions: terminalMenuSessions,
    onOpenTerminal: handleOpenTerminal,
    onOpenNewTerminal: handleOpenNewTerminal,
    onRunProjectScript: handleRunProjectScript,
    onPull: onPullSelectedThreadBranch,
    onRunAction: onRunSelectedThreadGitAction,
  };
  const handleEditFailedCreation = async () => {
    const creation = selectedThreadCreation?.message;
    if (!creation?.creation || routeThreadIdentity === null) {
      return;
    }
    // Open recovery by draft id or the sheet creates an empty draft and strands restored content.
    try {
      await recoverFailedThreadDraft(creation);
    } catch (error) {
      Dialog.alert(
        "Could not restore draft",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    clearPendingThreadCreationOutcome(routeThreadIdentity);
    navigation.dispatch(
      StackActions.replace("Thread", {
        draft: {
          draftId: restoredNewTaskDraftKey(creation.messageId),
          environmentId: String(creation.environmentId),
          projectId: String(creation.creation.projectId),
          ...(selectedThreadProject ? { title: selectedThreadProject.title } : {}),
        },
      }),
    );
  };
  const setupTurnStartedAt = composer.selectedThreadActivityRun?.startedAt ?? null;
  const { snapshot: worktreeSetupSnapshot, visible: worktreeSetup } = useWorktreeSetup({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
    preparing:
      composer.selectedThreadActivityRun?.status === "preparing" ||
      selectedThread?.runtime?.status === "preparing" ||
      selectedThread?.worktreePath != null ||
      (selectedThreadCreation?.message.creation?.workspaceMode === "worktree" &&
        selectedThreadCreation.outcome == null),
    turnStarted: setupTurnStartedAt !== null,
    followUpSent:
      composer.selectedThreadFeed.filter(
        (entry) => entry.type === "message" && entry.message.role === "user",
      ).length +
        composer.selectedThreadQueueCount >
      1,
  });
  const awaitingBootstrapTurn =
    worktreeSetup !== null
      ? worktreeSetup.phase === "running" && !worktreeSetupAgentStarted(worktreeSetup)
      : (selectedThreadDetail?.runs.some((run) => run.status === "preparing") ?? false);
  const cancelWorktreeSetup = useAtomCommand(vcsEnvironment.cancelWorktreeSetup);
  const handleCancelWorktreeSetup = () => {
    if (!selectedThread) return;
    void cancelWorktreeSetup({
      environmentId: selectedThread.environmentId,
      input: { threadId: selectedThread.id },
    });
  };
  const startLocalThread = useAtomCommand(threadEnvironment.startTurn, "work locally");
  const localResendBusy = useRef(false);
  const setupMessage = selectedThreadDetail?.messages.find((message) => message.role === "user");
  const handleWorkLocally = async () => {
    if (!selectedThread || !selectedThreadProject || !setupMessage || localResendBusy.current)
      return;
    localResendBusy.current = true;
    const result = await cancelWorktreeSetup({
      environmentId: selectedThread.environmentId,
      input: { threadId: selectedThread.id },
    });
    if (result._tag !== "Success" || !result.value.cancelled) {
      localResendBusy.current = false;
      return;
    }
    // V2 accepts launch before setup; cancellation cannot reject that delivery, so reuse server-owned prompt and uploads.
    const metadata = makeTurnCommandMetadata();
    const launched = await startLocalThread({
      environmentId: selectedThread.environmentId,
      input: buildProjectThreadStartTurnInput({
        ...metadata,
        projectId: selectedThread.projectId,
        projectCwd: selectedThreadProject.workspaceRoot,
        text: setupMessage.text,
        titleText: selectedThread.title,
        ...(setupMessage.context ? { context: setupMessage.context } : {}),
        uploadedAttachments: setupMessage.attachments,
        modelSelection: selectedThread.modelSelection,
        runtimeMode: selectedThread.runtimeMode,
        interactionMode: selectedThread.interactionMode,
        workspaceMode: "local",
        branch: null,
        worktreePath: null,
        startFromOrigin: false,
        worktreeBranchName: "",
      }),
    });
    localResendBusy.current = false;
    if (launched._tag !== "Success") return;
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: String(selectedThread.environmentId),
        threadId: metadata.threadId,
      }),
    );
  };
  const creationState = ((): ThreadDetailScreenProps["creationState"] => {
    if (selectedThreadCreation === null) {
      return awaitingBootstrapTurn
        ? { kind: "preparing", preparingWorktree: true, serverOwned: true }
        : null;
    }
    if (selectedThreadCreation.outcome?.kind === "failed") {
      return {
        kind: "failed",
        reason: selectedThreadCreation.outcome.reason,
        onEditTask: handleEditFailedCreation,
      };
    }
    return {
      kind: "preparing",
      preparingWorktree: selectedThreadCreation.message.creation?.workspaceMode === "worktree",
      serverOwned: false,
    };
  })();
  // Queued creation displays its prompt before server creation; temporary not-found is expected.
  const contentPresentation =
    creationState !== null
      ? { kind: "ready" as const }
      : projectThreadContentPresentation({
          hasDetail: selectedThreadDetail !== null,
          detailError: Option.getOrNull(selectedThreadDetailState.error),
          detailDeleted: selectedThreadDetailState.status === "deleted",
          connectionState: routeConnectionState,
        });
  const serverConfig = routeEnvironmentRuntime?.serverConfig ?? null;
  const hasThreadCwd = selectedThreadCwd !== null;
  const threadTitle = selectedThread?.title ?? "";
  // Publish content with structure so menu subtitles are ready on first open.
  const threadHeaderKey = [
    props.inspectorPresentation ? "inspector" : "thread",
    "live",
    environmentIdRaw ?? "",
    threadId ?? "",
    threadTitle,
    headerSubtitle,
    gitStructureKey,
    gitContentKey,
    fileInspector.supported ? "1" : "0",
    publishedInspectorMode ?? "",
    props.onReturnToThread ? "1" : "0",
  ] as const;
  const threadHeader =
    props.inspectorPresentation || threadTitle.length === 0 ? null : (
      <ThreadHeader
        title={threadTitle}
        subtitle={headerSubtitle}
        gitControls={threadGitControlProps}
        hasThreadCwd={hasThreadCwd}
        inspectorMode={publishedInspectorMode}
        onOpenFilesInspector={handleOpenFilesInspector}
        onReturnToThread={props.onReturnToThread}
      />
    );
  if (!environmentId || !threadId) {
    return (
      <ThreadOpenShell
        environmentId={environmentIdRaw}
        threadId={threadId}
        hideHeader={Boolean(props.inspectorPresentation)}
      />
    );
  }

  if (!selectedThread) {
    return (
      <ThreadOpenShell
        environmentId={environmentIdRaw}
        threadId={threadId}
        hideHeader={Boolean(props.inspectorPresentation)}
      />
    );
  }

  const renderThreadRouteBody = () => (
    <>
      <GitActionProgressOverlay
        progress={gitActionProgress}
        onDismiss={dismissGitActionResult}
        onOpenPullRequest={openPullRequest}
      />

      <>
        <ThreadScreenBinding
          header={threadHeader}
          headerKey={threadHeaderKey}
          canOperateThread={canOperateThread}
          selectedThread={selectedThreadWithDraftSettings ?? selectedThread}
          selectedThreadDetailRef={selectedThreadDetailRef}
          contentPresentation={contentPresentation}
          screenTone={connectionTone(routeConnectionState)}
          connectionError={routeConnectionError}
          environmentLabel={selectedEnvironmentConnection?.environmentLabel ?? null}
          feedbackSubmissions={composer.feedbackSubmissions}
          onDismissFeedback={composer.dismissFeedback}
          selectedThreadFeed={composer.selectedThreadFeed}
          pendingHandoff={composer.pendingHandoff}
          activityRun={composer.selectedThreadActivityRun}
          activeWorkStartedAt={
            creationState?.kind === "preparing" ||
            (worktreeSetup !== null && setupTurnStartedAt === null)
              ? null
              : composer.activeWorkStartedAt
          }
          isCompacting={composer.isCompacting}
          runlessWorkActive={composer.runlessWorkActive}
          extensionStatuses={composer.extensionStatuses}
          providerSubagentStatus={composer.providerSubagentStatus}
          creationState={creationState}
          setupWorkingStartedAt={
            composer.activeWorkStartedAt !== null &&
            worktreeSetupSnapshot !== null &&
            composer.selectedThreadFeed.filter(
              (entry) => entry.type === "message" && entry.message.role === "user",
            ).length <= 1
              ? composer.activeWorkStartedAt
              : null
          }
          worktreeSetup={
            worktreeSetup
              ? {
                  snapshot: worktreeSetup,
                  turnStartedAt: setupTurnStartedAt,
                  working: composer.activeWorkStartedAt !== null,
                  turnStarted: setupTurnStartedAt !== null,
                  onCancel: handleCancelWorktreeSetup,
                  onWorkLocally: setupMessage && selectedThreadProject ? handleWorkLocally : null,
                }
              : null
          }
          activePendingApproval={requests.activePendingApproval}
          activePendingApprovals={requests.activePendingApprovals}
          respondingApprovalId={requests.respondingApprovalId}
          activePendingUserInput={requests.activePendingUserInput}
          activePendingUserInputDrafts={requests.activePendingUserInputDrafts}
          activePendingUserInputAnswers={requests.activePendingUserInputAnswers}
          respondingUserInputId={requests.respondingUserInputId}
          connectionStateLabel={routeConnectionState}
          threadSyncStatus={selectedThreadDetailState.status}
          historyControls={historyControls}
          activeThreadBusy={composer.activeThreadBusy}
          canStopThread={awaitingBootstrapTurn || composer.interruptibleRunId !== null}
          queuedRunEdit={composer.queuedRunEdit}
          composerDraftKey={composer.composerDraftKey}
          followUpBehavior={composer.followUpBehavior}
          canSteerActiveTurn={composer.canSteerActiveTurn}
          isSavingQueuedEdit={composer.isSavingQueuedEdit}
          onCancelQueuedRunEdit={composer.cancelQueuedRunEdit}
          onRemoveQueuedEditAttachment={composer.onRemoveQueuedEditAttachment}
          environmentId={selectedThread.environmentId}
          projectWorkspaceRoot={selectedThreadProject?.workspaceRoot ?? null}
          threadCwd={selectedThreadCwd}
          selectedThreadQueueCount={composer.selectedThreadQueueCount}
          queuedMessages={
            selectedThreadCreation && selectedThreadCreation.outcome?.kind !== "delivered"
              ? [selectedThreadCreation.message, ...composer.selectedThreadQueuedMessages]
              : composer.selectedThreadQueuedMessages
          }
          dispatchingMessageId={composer.dispatchingQueuedMessageId}
          layoutVariant={layout.variant}
          usesAutomaticContentInsets={usesNativeHeaderGlass}
          onOpenConnectionEditor={handleOpenConnectionEditor}
          onChangeDraftMessage={composer.onChangeDraftMessage}
          onPickDraftMedia={composer.onPickDraftMedia}
          onPickDraftFiles={composer.onPickDraftFiles}
          onNativePasteImages={composer.onNativePasteImages}
          onNativePasteText={composer.onNativePasteText}
          onRemoveDraftImage={composer.onRemoveDraftImage}
          serverConfig={serverConfig}
          onStopThread={awaitingBootstrapTurn ? handleCancelWorktreeSetup : handleStopThread}
          onResumeQueue={
            composer.queueHeld || composer.resumableRunId !== null ? handleResumeQueue : null
          }
          onSendMessage={composer.onSendMessage}
          offersSideChat={composer.sideChatUnavailableReason === null}
          onReconnectEnvironment={handleReconnectEnvironment}
          canSwitchThreadProvider={composer.canSwitchThreadProvider}
          onRespondToApproval={requests.onRespondToApproval}
          onSelectUserInputOption={requests.onSelectUserInputOption}
          onChangeUserInputCustomAnswer={requests.onChangeUserInputCustomAnswer}
          onSubmitUserInput={requests.onSubmitUserInput}
          onDismissUserInput={requests.onDismissUserInput}
        />
      </>
    </>
  );

  return (
    <>
      {!props.inspectorPresentation && inspectorContent ? (
        <Inspector
          // A route's own inspector (files) opens once per thread; going back keeps the user's choice.
          revealKey={
            props.renderInspector !== undefined && selectedThreadCwd !== null
              ? (routeThreadIdentity ?? undefined)
              : undefined
          }
          content={inspectorContent}
        />
      ) : null}

      {renderThreadRouteBody()}
    </>
  );
}

export function FullscreenThreadRouteScreen(
  props: StaticScreenProps<{
    readonly environmentId: string;
    readonly threadId: string;
  }>,
) {
  const navigation = useNavigation();
  return (
    <InspectorContentScope>
      <ThreadRouteScreen
        route={props.route}
        inspectorPresentation={{ onClose: () => navigation.goBack() }}
      />
    </InspectorContentScope>
  );
}

/** Reads the pane state itself, so a sidebar toggle doesn't re-render the whole thread screen. */
function ThreadInspectorPreviewWhileVisible(props: Parameters<typeof ThreadInspectorPreview>[0]) {
  const { panes } = useWorkspacePaneState();
  return panes.auxiliaryPaneVisible ? <ThreadInspectorPreview {...props} /> : null;
}
