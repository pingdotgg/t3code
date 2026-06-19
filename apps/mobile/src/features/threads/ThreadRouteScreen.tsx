import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import * as Option from "effect/Option";
import {
  EnvironmentId,
  type ModelSelection,
  type ProjectScript,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { Pressable, ScrollView, Text as RNText, View } from "react-native";
import { useWorkspaceState } from "../../state/workspace";
import { useThemeColor } from "../../lib/useThemeColor";
import { useEnvironmentQuery } from "../../state/query";
import { dismissGitActionResult, useGitActionProgress } from "../../state/use-vcs-action-state";
import { vcsEnvironment } from "../../state/vcs";

import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { buildThreadRoutePath, buildThreadTerminalNavigation } from "../../lib/routes";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { connectionTone } from "../connection/connectionTone";

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
import { ThreadNavigationDrawer } from "./ThreadNavigationDrawer";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../state/use-selected-thread-git-state";
import { useSelectedThreadRequests } from "../../state/use-selected-thread-requests";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { threadEnvironment } from "../../state/threads";
import { projectThreadContentPresentation } from "./threadContentPresentation";

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function OpeningThreadLoadingScreen() {
  return <LoadingScreen message="Opening thread…" messagePlacement="above-spinner" />;
}

export function ThreadRouteScreen() {
  const { state: workspaceState } = useWorkspaceState();
  const { connectionState } = useRemoteConnectionStatus();
  const { onReconnectEnvironment } = useRemoteConnections();
  const { selectedThread, selectedThreadProject, selectedEnvironmentConnection } =
    useThreadSelection();
  const selectedThreadDetailState = useSelectedThreadDetailState();
  const selectedThreadDetail = Option.getOrNull(selectedThreadDetailState.data);
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const composer = useThreadComposerState();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const requests = useSelectedThreadRequests();
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread metadata update",
  );
  const setThreadRuntimeMode = useAtomCommand(
    threadEnvironment.setRuntimeMode,
    "thread runtime mode",
  );
  const setThreadInteractionMode = useAtomCommand(
    threadEnvironment.setInteractionMode,
    "thread interaction mode",
  );
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
  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const routeConnectionState =
    routeEnvironmentRuntime?.connectionState ?? (environmentId ? "available" : connectionState);
  const routeConnectionError = routeEnvironmentRuntime?.connectionError ?? null;

  /* ─── Native header theming ──────────────────────────────────────── */
  const iconColor = String(useThemeColor("--color-icon"));
  const foregroundColor = String(useThemeColor("--color-foreground"));
  const secondaryFg = String(useThemeColor("--color-foreground-secondary"));

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
    setDrawerVisible(true);
  }, []);

  const handleOpenConnectionEditor = useCallback(() => {
    void router.push("/connections");
  }, [router]);
  const handleUpdateThreadModelSelection = useCallback(
    (modelSelection: ModelSelection) => {
      if (!selectedThread) {
        return;
      }
      return updateThreadMetadata({
        environmentId: selectedThread.environmentId,
        input: {
          threadId: selectedThread.id,
          modelSelection,
        },
      });
    },
    [selectedThread, updateThreadMetadata],
  );
  const handleUpdateThreadRuntimeMode = useCallback(
    (runtimeMode: RuntimeMode) => {
      if (!selectedThread) {
        return;
      }
      return setThreadRuntimeMode({
        environmentId: selectedThread.environmentId,
        input: {
          threadId: selectedThread.id,
          runtimeMode,
        },
      });
    },
    [selectedThread, setThreadRuntimeMode],
  );
  const handleUpdateThreadInteractionMode = useCallback(
    (interactionMode: ProviderInteractionMode) => {
      if (!selectedThread) {
        return;
      }
      return setThreadInteractionMode({
        environmentId: selectedThread.environmentId,
        input: {
          threadId: selectedThread.id,
          interactionMode,
        },
      });
    },
    [selectedThread, setThreadInteractionMode],
  );
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
    const stillHydrating =
      workspaceState.isLoadingConnections ||
      routeConnectionState === "connecting" ||
      routeConnectionState === "reconnecting";

    if (stillHydrating) {
      return <OpeningThreadLoadingScreen />;
    }

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

  const selectedThreadKey = scopedThreadKey(selectedThread.environmentId, selectedThread.id);
  const contentPresentation = projectThreadContentPresentation({
    hasDetail: selectedThreadDetail !== null,
    detailError: Option.getOrNull(selectedThreadDetailState.error),
    detailDeleted: selectedThreadDetailState.status === "deleted",
    connectionState: routeConnectionState,
  });
  const serverConfig = routeEnvironmentRuntime?.serverConfig ?? null;

  const headerSubtitle = [
    selectedThreadProject?.title ?? null,
    selectedEnvironmentConnection?.environmentLabel ?? null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          headerTransparent: true,
          headerStyle: { backgroundColor: "transparent" },
          headerShadowVisible: false,
          headerTintColor: iconColor,
          headerBackTitle: "",
          headerTitle: () => (
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
                  fontSize: 18,
                  fontWeight: "900",
                  color: foregroundColor,
                  letterSpacing: -0.4,
                }}
              >
                {selectedThread.title}
              </RNText>
              <RNText
                numberOfLines={1}
                style={{
                  fontFamily: "DMSans_700Bold",
                  fontSize: 12,
                  fontWeight: "700",
                  color: secondaryFg,
                  letterSpacing: 0.3,
                }}
              >
                {headerSubtitle}
              </RNText>
            </Pressable>
          ),
        }}
      />

      <ThreadGitControls
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

      <View className="flex-1 bg-screen">
        <ThreadDetailScreen
          selectedThread={selectedThread}
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
          onUpdateThreadModelSelection={handleUpdateThreadModelSelection}
          onUpdateThreadRuntimeMode={handleUpdateThreadRuntimeMode}
          onUpdateThreadInteractionMode={handleUpdateThreadInteractionMode}
          onRespondToApproval={requests.onRespondToApproval}
          onSelectUserInputOption={requests.onSelectUserInputOption}
          onChangeUserInputCustomAnswer={requests.onChangeUserInputCustomAnswer}
          onSubmitUserInput={requests.onSubmitUserInput}
        />

        <ThreadNavigationDrawer
          visible={drawerVisible}
          selectedThreadKey={selectedThreadKey}
          onClose={() => setDrawerVisible(false)}
          onSelectThread={(thread) => {
            router.replace(buildThreadRoutePath(thread));
          }}
          onStartNewTask={() => router.push("/new")}
        />
      </View>
    </>
  );
}
