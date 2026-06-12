import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";
import { EnvironmentId, type ProjectScript } from "@t3tools/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { Pressable, ScrollView, Text as RNText, View, useColorScheme } from "react-native";
import { useThemeColor } from "../../lib/useThemeColor";
import { useVcsStatus } from "../../state/use-vcs-status";
import { dismissGitActionResult, useGitActionProgress } from "../../state/use-vcs-action-state";

import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { buildThreadRoutePath, buildThreadTerminalNavigation } from "../../lib/routes";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { connectionTone } from "../connection/connectionTone";

import { useRemoteCatalog } from "../../state/use-remote-catalog";
import {
  useRemoteConnectionStatus,
  useRemoteEnvironmentState,
} from "../../state/use-remote-environment-registry";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
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
import { useSelectedThreadCommands } from "../../state/use-selected-thread-commands";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../state/use-selected-thread-git-state";
import { useSelectedThreadRequests } from "../../state/use-selected-thread-requests";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadComposerState } from "../../state/use-thread-composer-state";

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
  const { isLoadingSavedConnection, environmentStateById, pendingConnectionError } =
    useRemoteEnvironmentState();
  const { connectionState, connectionError: aggregateConnectionError } =
    useRemoteConnectionStatus();
  const { projects, threads } = useRemoteCatalog();
  const { selectedThread, selectedThreadProject, selectedEnvironmentConnection } =
    useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const composer = useThreadComposerState();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const requests = useSelectedThreadRequests();
  const commands = useSelectedThreadCommands({
    refreshSelectedThreadGitStatus: gitActions.refreshSelectedThreadGitStatus,
  });
  const router = useRouter();
  const params = useLocalSearchParams<{
    environmentId?: string | string[];
    threadId?: string | string[];
  }>();
  const [drawerVisible, setDrawerVisible] = useState(false);
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const threadId = firstRouteParam(params.threadId);
  const routeEnvironmentRuntime = environmentId
    ? (environmentStateById[environmentId] ?? null)
    : null;
  const routeConnectionState = routeEnvironmentRuntime?.connectionState ?? connectionState;
  const routeConnectionError =
    pendingConnectionError ?? routeEnvironmentRuntime?.connectionError ?? aggregateConnectionError;

  /* ─── Native header theming ──────────────────────────────────────── */
  const isDark = useColorScheme() === "dark";
  const iconColor = String(useThemeColor("--color-icon"));
  const foregroundColor = String(useThemeColor("--color-foreground"));
  const secondaryFg = isDark ? "#a3a3a3" : "#525252";

  /* ─── Git status for native header trigger ───────────────────────── */
  const gitStatus = useVcsStatus({
    environmentId: selectedThread?.environmentId ?? null,
    cwd: selectedThreadCwd,
  });
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
      isLoadingSavedConnection ||
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

  if (!selectedThreadDetail) {
    return <OpeningThreadLoadingScreen />;
  }

  const selectedThreadKey = scopedThreadKey(selectedThread.environmentId, selectedThread.id);
  const serverConfig =
    routeEnvironmentRuntime?.serverConfig ??
    pipe(
      Object.values(environmentStateById),
      Arr.map((runtime) => runtime.serverConfig),
      Arr.findFirst((value) => value !== null),
      Option.getOrNull,
    );

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
                {selectedThreadDetail.title}
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
        currentBranch={selectedThreadDetail.branch}
        gitStatus={gitStatus.data}
        gitOperationLabel={gitState.gitOperationLabel}
        canOpenTerminal={Boolean(selectedThreadProject?.workspaceRoot)}
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
          selectedThread={selectedThreadDetail}
          screenTone={connectionTone(routeConnectionState)}
          connectionError={routeConnectionError}
          httpBaseUrl={selectedEnvironmentConnection?.httpBaseUrl ?? null}
          bearerToken={selectedEnvironmentConnection?.bearerToken ?? null}
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
          selectedThreadQueueCount={composer.selectedThreadQueueCount}
          onOpenDrawer={handleOpenDrawer}
          onOpenConnectionEditor={handleOpenConnectionEditor}
          onChangeDraftMessage={composer.onChangeDraftMessage}
          onPickDraftImages={composer.onPickDraftImages}
          onNativePasteImages={composer.onNativePasteImages}
          onRemoveDraftImage={composer.onRemoveDraftImage}
          serverConfig={serverConfig}
          onStopThread={commands.onStopThread}
          onSendMessage={composer.onSendMessage}
          onUpdateThreadModelSelection={commands.onUpdateThreadModelSelection}
          onUpdateThreadRuntimeMode={commands.onUpdateThreadRuntimeMode}
          onUpdateThreadInteractionMode={commands.onUpdateThreadInteractionMode}
          onRespondToApproval={requests.onRespondToApproval}
          onSelectUserInputOption={requests.onSelectUserInputOption}
          onChangeUserInputCustomAnswer={requests.onChangeUserInputCustomAnswer}
          onSubmitUserInput={requests.onSubmitUserInput}
        />

        <ThreadNavigationDrawer
          visible={drawerVisible}
          projects={projects}
          threads={threads}
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
