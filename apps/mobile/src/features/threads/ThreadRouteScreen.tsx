import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/build/react-navigation/elements";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Option from "effect/Option";
import { EnvironmentId, ThreadId, type ProjectScript } from "@t3tools/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { Platform, Pressable, ScrollView, Text as RNText, View } from "react-native";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { useWorkspaceState } from "../../state/workspace";
import { useThemeColor } from "../../lib/useThemeColor";
import { useEnvironmentQuery } from "../../state/query";
import { dismissGitActionResult, useGitActionProgress } from "../../state/use-vcs-action-state";
import { vcsEnvironment } from "../../state/vcs";

import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import {
  buildThreadFilesNavigation,
  buildThreadRoutePath,
  buildThreadTerminalNavigation,
} from "../../lib/routes";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { connectionTone } from "../connection/connectionTone";
import { nativeTopScrollEdgeEffect } from "../../lib/native-scroll-edge-effect";

import {
  useRemoteConnections,
  useRemoteConnectionStatus,
  useRemoteEnvironmentRuntime,
} from "../../state/use-remote-environment-registry";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
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
import { terminalDebugLog } from "../terminal/terminalDebugLog";
import { ThreadDetailScreen } from "./ThreadDetailScreen";
import { ThreadGitControls } from "./ThreadGitControls";
import { GitOverviewSheet } from "./git/GitOverviewSheet";
import { ThreadNavigationDrawer } from "./ThreadNavigationDrawer";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../state/use-selected-thread-git-state";
import { useSelectedThreadRequests } from "../../state/use-selected-thread-requests";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { threadEnvironment } from "../../state/threads";
import { projectThreadContentPresentation } from "./threadContentPresentation";
import { AdaptiveInspectorLayout } from "../layout/adaptive-inspector-layout";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
} from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { ThreadFileNavigatorPane } from "../files/thread-file-navigator-pane";
import {
  ThreadInspectorContentStack,
  type ThreadInspectorMode,
} from "./thread-inspector-content-stack";

interface ThreadInspectorSelection {
  readonly routeThreadIdentity: string | null;
  readonly mode: ThreadInspectorMode;
}

const USES_NATIVE_GLASS_HEADER = Platform.OS === "ios" && isLiquidGlassAvailable();
const TOP_SCROLL_EDGE_EFFECT = nativeTopScrollEdgeEffect(Platform.OS, Platform.Version);

function InspectorPaneRoleActivation() {
  useAdaptiveWorkspacePaneRole("inspector");
  return null;
}

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function OpeningThreadLoadingScreen() {
  return <LoadingScreen message="Opening thread…" messagePlacement="above-spinner" />;
}

interface ThreadRouteScreenProps {
  readonly onReturnToThread?: () => void;
  readonly renderInspector?: () => ReactNode;
}

function ThreadUnavailableScreen() {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: "center",
        paddingHorizontal: 24,
        paddingVertical: 32,
      }}
      className="bg-screen flex-1"
    >
      <EmptyState
        title="Thread unavailable"
        detail="This thread is not available in the current mobile snapshot."
      />
    </ScrollView>
  );
}

export function ThreadRouteScreen(props: ThreadRouteScreenProps = {}) {
  const { state: workspaceState } = useWorkspaceState();
  const { connectionState } = useRemoteConnectionStatus();
  const { selectedThread } = useThreadSelection();
  const params = useLocalSearchParams<{
    environmentId?: string | string[];
    threadId?: string | string[];
  }>();
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const threadIdRaw = firstRouteParam(params.threadId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
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
  const hasThreadDetail = Option.isSome(selectedThreadDetailState.data);
  const hasTerminalDetailState =
    selectedThreadDetailState.status === "deleted" ||
    Option.isSome(selectedThreadDetailState.error);

  if (environmentId === null || threadIdRaw === null) {
    return <OpeningThreadLoadingScreen />;
  }

  if (selectedThread !== null && selectedThreadKey === routeThreadKey) {
    if (!hasThreadDetail && !hasTerminalDetailState) {
      return <OpeningThreadLoadingScreen />;
    }
    return <ThreadRouteContent {...props} selectedThreadDetailState={selectedThreadDetailState} />;
  }

  const stillHydrating =
    workspaceState.isLoadingConnections ||
    routeConnectionState === "connecting" ||
    routeConnectionState === "reconnecting";

  if (stillHydrating) {
    return <OpeningThreadLoadingScreen />;
  }

  return <ThreadUnavailableScreen />;
}

function ThreadHeaderTitle(props: {
  readonly foregroundColor: string;
  readonly secondaryForegroundColor: string;
  readonly subtitle: string;
  readonly title: string;
}) {
  return (
    <Pressable
      style={{ alignItems: "center", maxWidth: 200 }}
      onLongPress={() => {
        // TODO: trigger rename modal
      }}
    >
      <RNText
        numberOfLines={1}
        style={{
          fontFamily: "DMSans_700Bold",
          fontSize: MOBILE_TYPOGRAPHY.headline.fontSize,
          fontWeight: "900",
          color: props.foregroundColor,
          letterSpacing: -0.4,
        }}
      >
        {props.title}
      </RNText>
      <RNText
        numberOfLines={1}
        style={{
          fontFamily: "DMSans_700Bold",
          fontSize: MOBILE_TYPOGRAPHY.label.fontSize,
          fontWeight: "700",
          color: props.secondaryForegroundColor,
          letterSpacing: 0.3,
        }}
      >
        {props.subtitle}
      </RNText>
    </Pressable>
  );
}

function ThreadRouteContent(
  props: ThreadRouteScreenProps & {
    readonly selectedThreadDetailState: ReturnType<typeof useSelectedThreadDetailState>;
  },
) {
  const { fileInspector, layout, showAuxiliaryPane, toggleAuxiliaryPane } =
    useAdaptiveWorkspaceLayout();
  const headerHeight = useHeaderHeight();
  const { connectionState } = useRemoteConnectionStatus();
  const { onReconnectEnvironment } = useRemoteConnections();
  const { selectedThread, selectedThreadProject, selectedEnvironmentConnection } =
    useThreadSelection();
  const selectedThreadDetailState = props.selectedThreadDetailState;
  const selectedThreadDetail = Option.getOrNull(selectedThreadDetailState.data);
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const composer = useThreadComposerState();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const requests = useSelectedThreadRequests();
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, "thread interrupt");
  const router = useRouter();
  const params = useLocalSearchParams<{
    environmentId?: string | string[];
    threadId?: string | string[];
  }>();
  const [drawerVisible, setDrawerVisible] = useState(false);
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const threadId = firstRouteParam(params.threadId);
  const routeThreadIdentity =
    environmentIdRaw !== null && threadId !== null ? `${environmentIdRaw}:${threadId}` : null;
  const [inspectorSelection, setInspectorSelection] = useState<ThreadInspectorSelection | null>(
    () => (props.renderInspector ? { routeThreadIdentity, mode: "route" } : null),
  );
  const inspectorMode =
    inspectorSelection?.routeThreadIdentity === routeThreadIdentity
      ? inspectorSelection.mode
      : null;

  useFocusEffect(
    useCallback(() => {
      return () => {
        if (props.renderInspector === undefined) {
          // Inspectors are contextual to this chat destination. Clear the
          // hidden chat copy after a native push so returning from Files,
          // Review, or Terminal cannot reserve an empty trailing pane.
          setInspectorSelection(null);
        }
      };
    }, [props.renderInspector]),
  );
  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const routeConnectionState =
    routeEnvironmentRuntime?.connectionState ?? (environmentId ? "available" : connectionState);
  const routeConnectionError = routeEnvironmentRuntime?.connectionError ?? null;
  const selectedThreadWithDraftSettings = useMemo(
    () =>
      selectedThread
        ? {
            ...selectedThread,
            modelSelection: composer.modelSelection ?? selectedThread.modelSelection,
            runtimeMode: composer.runtimeMode ?? selectedThread.runtimeMode,
            interactionMode: composer.interactionMode ?? selectedThread.interactionMode,
          }
        : null,
    [composer.interactionMode, composer.modelSelection, composer.runtimeMode, selectedThread],
  );

  /* ─── Native header theming ──────────────────────────────────────── */
  const iconColor = String(useThemeColor("--color-icon"));
  const foregroundColor = String(useThemeColor("--color-foreground"));
  const secondaryFg = String(useThemeColor("--color-foreground-secondary"));
  const headerSubtitle = [
    selectedThreadProject?.title ?? null,
    selectedEnvironmentConnection?.environmentLabel ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
  /* ─── Git status for native header trigger ───────────────────────── */
  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
  const terminalMenuSessions = useMemo(
    () =>
      buildTerminalMenuSessions({
        knownSessions: knownTerminalSessions,
        workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
      }),
    [knownTerminalSessions, selectedThreadProject?.workspaceRoot],
  );
  const selectedThreadDetailWorktreePath = selectedThreadDetail?.worktreePath ?? null;
  const handleReconnectEnvironment = useCallback(() => {
    if (!environmentId) {
      return;
    }
    onReconnectEnvironment(environmentId);
  }, [environmentId, onReconnectEnvironment]);

  /* ─── Git action progress (for overlay banner) ──────────────────── */
  const gitActionProgressTarget = useMemo(
    () => ({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadCwd,
    }),
    [selectedThread?.environmentId, selectedThreadCwd],
  );
  const gitActionProgress = useGitActionProgress(gitActionProgressTarget);

  const handleOpenDrawer = useCallback(() => {
    if (!layout.usesSplitView) {
      setDrawerVisible(true);
    }
  }, [layout.usesSplitView]);

  useEffect(() => {
    if (layout.usesSplitView) {
      setDrawerVisible(false);
    }
  }, [layout.usesSplitView]);

  const handleOpenGitInspector = useCallback(() => {
    setInspectorSelection({ routeThreadIdentity, mode: "git" });
    showAuxiliaryPane("inspector");
  }, [routeThreadIdentity, showAuxiliaryPane]);
  const handleOpenFilesInspector = useCallback(() => {
    if (!fileInspector.supported || selectedThread === null || selectedThreadCwd === null) {
      return;
    }
    setInspectorSelection({
      routeThreadIdentity,
      mode: props.renderInspector === undefined ? "files" : "route",
    });
    showAuxiliaryPane("inspector");
  }, [
    fileInspector.supported,
    props.renderInspector,
    routeThreadIdentity,
    selectedThread,
    selectedThreadCwd,
    showAuxiliaryPane,
  ]);
  const inspectorToggleActionRef = useRef({
    inspectorMode,
    openFilesInspector: handleOpenFilesInspector,
    toggleAuxiliaryPane,
  });
  inspectorToggleActionRef.current = {
    inspectorMode,
    openFilesInspector: handleOpenFilesInspector,
    toggleAuxiliaryPane,
  };
  const handleToggleInspector = useCallback(() => {
    const action = inspectorToggleActionRef.current;
    if (action.inspectorMode === null) {
      action.openFilesInspector();
      return;
    }
    action.toggleAuxiliaryPane();
  }, []);
  const handleSelectInspectorFile = useCallback(
    (path: string) => {
      if (selectedThread === null) {
        return;
      }
      router.push(buildThreadFilesNavigation(selectedThread, path));
    },
    [router, selectedThread],
  );
  const GitInspector = useCallback(
    () => <GitOverviewSheet headerInset={headerHeight} presentation="inspector" />,
    [headerHeight],
  );
  const FilesInspector = useCallback(
    () =>
      selectedThread !== null && selectedThreadCwd !== null ? (
        <ThreadFileNavigatorPane
          cwd={selectedThreadCwd}
          environmentId={selectedThread.environmentId}
          headerInset={headerHeight}
          projectName={selectedThreadProject?.title ?? "Files"}
          selectedPath={null}
          onSelectFile={handleSelectInspectorFile}
        />
      ) : null,
    [
      handleSelectInspectorFile,
      headerHeight,
      selectedThread,
      selectedThreadCwd,
      selectedThreadProject?.title,
    ],
  );
  const renderInspectorStack = useCallback(
    () =>
      inspectorMode === null ? null : (
        <ThreadInspectorContentStack
          Files={FilesInspector}
          Git={GitInspector}
          mode={inspectorMode}
          Route={props.renderInspector}
        />
      ),
    [FilesInspector, GitInspector, inspectorMode, props.renderInspector],
  );
  const activeInspectorRenderer = inspectorMode === null ? undefined : renderInspectorStack;

  const handleOpenConnectionEditor = useCallback(() => {
    void router.push("/connections");
  }, [router]);
  const handleStopThread = useCallback(() => {
    if (
      !selectedThread ||
      (selectedThread.session?.status !== "running" &&
        selectedThread.session?.status !== "starting")
    ) {
      return;
    }
    return interruptThreadTurn({
      environmentId: selectedThread.environmentId,
      input: {
        threadId: selectedThread.id,
        ...(selectedThread.session.activeTurnId
          ? { turnId: selectedThread.session.activeTurnId }
          : {}),
      },
    });
  }, [interruptThreadTurn, selectedThread]);

  const handleOpenTerminal = useCallback(
    (nextTerminalId?: string | null) => {
      terminalDebugLog("terminal-menu:open-existing", {
        terminalId: nextTerminalId ?? null,
        hasThread: Boolean(selectedThread),
        hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      });

      if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
        return;
      }

      void router.push(buildThreadTerminalNavigation(selectedThread, nextTerminalId));
    },
    [router, selectedThread, selectedThreadProject?.workspaceRoot],
  );

  const handleOpenNewTerminal = useCallback(() => {
    terminalDebugLog("terminal-menu:open-new", {
      hasThread: Boolean(selectedThread),
      hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
    });

    if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
      return;
    }

    const nextId = nextOpenTerminalId({
      listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
    });
    void router.push(buildThreadTerminalNavigation(selectedThread, nextId));
  }, [router, selectedThread, selectedThreadProject?.workspaceRoot, terminalMenuSessions]);

  const handleRunProjectScript = useCallback(
    async (script: ProjectScript) => {
      terminalDebugLog("project-script:press", {
        scriptId: script.id,
        command: script.command,
        hasThread: Boolean(selectedThread),
        hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      });

      if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
        terminalDebugLog("project-script:abort", {
          scriptId: script.id,
          reason: "no-thread-or-workspace",
        });
        return;
      }

      const targetTerminalId = resolveProjectScriptTerminalId({
        existingTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
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
          initialInput: `${script.command}\r`,
        },
      });
      terminalDebugLog("project-script:staged", {
        scriptId: script.id,
        terminalId: targetTerminalId,
        cwd,
        worktreePath: preferredWorktreePath,
      });

      void router.push(buildThreadTerminalNavigation(selectedThread, targetTerminalId));
    },
    [
      router,
      selectedThread,
      selectedThreadDetailWorktreePath,
      selectedThreadProject,
      terminalMenuSessions,
    ],
  );

  if (!environmentId || !threadId) {
    return <OpeningThreadLoadingScreen />;
  }

  if (!selectedThread) {
    return <OpeningThreadLoadingScreen />;
  }

  const selectedThreadKey = scopedThreadKey(selectedThread.environmentId, selectedThread.id);
  const contentPresentation = projectThreadContentPresentation({
    hasDetail: selectedThreadDetail !== null,
    detailError: Option.getOrNull(selectedThreadDetailState.error),
    detailDeleted: selectedThreadDetailState.status === "deleted",
    connectionState: routeConnectionState,
  });
  const serverConfig = routeEnvironmentRuntime?.serverConfig ?? null;

  return (
    <>
      {activeInspectorRenderer ? <InspectorPaneRoleActivation /> : null}
      <Stack.Screen
        options={{
          headerShown: true,
          headerTransparent: USES_NATIVE_GLASS_HEADER,
          headerBlurEffect: USES_NATIVE_GLASS_HEADER ? "systemThinMaterial" : undefined,
          headerShadowVisible: false,
          ...(USES_NATIVE_GLASS_HEADER
            ? { headerStyle: { backgroundColor: "transparent" } }
            : {
                headerStyle: { backgroundColor: "transparent" },
                headerShadowVisible: false,
              }),
          headerTintColor: iconColor,
          headerBackVisible: !layout.usesSplitView,
          headerBackTitle: "",
          scrollEdgeEffects: {
            // The native header material handles the effect on iOS 27 because
            // this virtualized list is not discoverable by the stack's native
            // first-descendant scroll-view lookup.
            top: USES_NATIVE_GLASS_HEADER ? "hidden" : TOP_SCROLL_EDGE_EFFECT,
            bottom: "hidden",
            left: "hidden",
            right: "hidden",
          },
        }}
      />

      <Stack.Screen.Title asChild>
        <ThreadHeaderTitle
          foregroundColor={foregroundColor}
          secondaryForegroundColor={secondaryFg}
          subtitle={headerSubtitle}
          title={selectedThread.title}
        />
      </Stack.Screen.Title>

      <WorkspaceSidebarToolbar>
        {props.onReturnToThread ? (
          <Stack.Toolbar.Button
            accessibilityLabel="Return to chat"
            icon="chevron.left"
            onPress={props.onReturnToThread}
          />
        ) : null}
      </WorkspaceSidebarToolbar>

      <ThreadGitControls
        auxiliaryPaneControl={
          fileInspector.supported && selectedThreadCwd !== null
            ? {
                accessibilityLabel: "Toggle inspector",
                onPress: handleToggleInspector,
              }
            : undefined
        }
        onOpenFilesInspector={
          fileInspector.supported && selectedThreadCwd !== null
            ? handleOpenFilesInspector
            : undefined
        }
        onOpenGitInspector={fileInspector.supported ? handleOpenGitInspector : undefined}
        currentBranch={selectedThread.branch}
        gitStatus={gitStatus.data}
        gitOperationLabel={gitState.gitOperationLabel}
        canOpenTerminal={Boolean(selectedThreadProject?.workspaceRoot)}
        canOpenFiles={Boolean(selectedThreadProject?.workspaceRoot)}
        projectScripts={selectedThreadProject?.scripts ?? []}
        terminalSessions={terminalMenuSessions}
        onOpenTerminal={handleOpenTerminal}
        onOpenNewTerminal={handleOpenNewTerminal}
        onRunProjectScript={handleRunProjectScript}
        onPull={gitActions.onPullSelectedThreadBranch}
        onRunAction={gitActions.onRunSelectedThreadGitAction}
      />

      <GitActionProgressOverlay progress={gitActionProgress} onDismiss={dismissGitActionResult} />

      <AdaptiveInspectorLayout renderInspector={activeInspectorRenderer}>
        <View className="flex-1 bg-screen">
          <ThreadDetailScreen
            selectedThread={selectedThreadWithDraftSettings ?? selectedThread}
            contentPresentation={contentPresentation}
            screenTone={connectionTone(routeConnectionState)}
            connectionError={routeConnectionError}
            environmentLabel={selectedEnvironmentConnection?.environmentLabel ?? null}
            selectedThreadFeed={composer.selectedThreadFeed}
            activeWorkStartedAt={composer.activeWorkStartedAt}
            activePendingApproval={requests.activePendingApproval}
            respondingApprovalId={requests.respondingApprovalId}
            activePendingUserInput={requests.activePendingUserInput}
            activePendingUserInputDrafts={requests.activePendingUserInputDrafts}
            activePendingUserInputAnswers={requests.activePendingUserInputAnswers}
            respondingUserInputId={requests.respondingUserInputId}
            draftMessage={composer.draftMessage}
            draftAttachments={composer.draftAttachments}
            connectionStateLabel={routeConnectionState}
            activeThreadBusy={composer.activeThreadBusy}
            environmentId={selectedThread.environmentId}
            projectWorkspaceRoot={selectedThreadProject?.workspaceRoot ?? null}
            threadCwd={selectedThreadCwd}
            selectedThreadQueueCount={composer.selectedThreadQueueCount}
            layoutVariant={layout.variant}
            usesAutomaticContentInsets={USES_NATIVE_GLASS_HEADER}
            onOpenDrawer={handleOpenDrawer}
            onOpenConnectionEditor={handleOpenConnectionEditor}
            onChangeDraftMessage={composer.onChangeDraftMessage}
            onPickDraftImages={composer.onPickDraftImages}
            onNativePasteImages={composer.onNativePasteImages}
            onRemoveDraftImage={composer.onRemoveDraftImage}
            serverConfig={serverConfig}
            onStopThread={handleStopThread}
            onSendMessage={composer.onSendMessage}
            onReconnectEnvironment={handleReconnectEnvironment}
            onUpdateThreadModelSelection={composer.onUpdateModelSelection}
            onUpdateThreadRuntimeMode={composer.onUpdateRuntimeMode}
            onUpdateThreadInteractionMode={composer.onUpdateInteractionMode}
            onRespondToApproval={requests.onRespondToApproval}
            onSelectUserInputOption={requests.onSelectUserInputOption}
            onChangeUserInputCustomAnswer={requests.onChangeUserInputCustomAnswer}
            onSubmitUserInput={requests.onSubmitUserInput}
          />

          {layout.usesSplitView ? null : (
            <ThreadNavigationDrawer
              visible={drawerVisible}
              selectedThreadKey={selectedThreadKey}
              onClose={() => setDrawerVisible(false)}
              onSelectThread={(thread) => {
                router.replace(buildThreadRoutePath(thread));
              }}
              onStartNewTask={() => router.push("/new")}
            />
          )}
        </View>
      </AdaptiveInspectorLayout>
    </>
  );
}
