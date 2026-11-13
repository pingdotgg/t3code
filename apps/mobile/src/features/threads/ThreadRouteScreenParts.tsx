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
import type { ThreadRouteScreenProps } from "./ThreadRouteScreen";
import { OpeningThreadLoadingScreen, ThreadRouteContent, ThreadUnavailableScreen, UnavailableThreadDraftRedirect, firstRouteParam } from "./ThreadRouteScreen";

export function LiveThreadRouteController(props: ThreadRouteScreenProps) {
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
  const withInspectorHeader = (content: ReactNode) => (
    <>
      {props.inspectorPresentation ? (
        <ThreadInspectorHeader
          title={selectedThread?.title ?? "Thread"}
          {...props.inspectorPresentation}
        />
      ) : null}
      {content}
    </>
  );

  if (environmentId === null || threadIdRaw === null) {
    return withInspectorHeader(<OpeningThreadLoadingScreen />);
  }

  if (selectedThread !== null && selectedThreadKey === routeThreadKey) {
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
    return withInspectorHeader(<OpeningThreadLoadingScreen />);
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

