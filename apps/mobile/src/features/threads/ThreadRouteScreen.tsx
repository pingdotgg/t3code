import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";
import { Pressable, ScrollView, Text as RNText, View, useColorScheme } from "react-native";
import { useThemeColor } from "../../lib/useThemeColor";
import { useGitStatus, gitStatusManager } from "../../state/use-git-status";
import { dismissGitActionResult, useGitActionProgress } from "../../state/use-git-action-state";

import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { buildThreadRoutePath } from "../../lib/routes";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { connectionTone } from "../connection/connectionTone";

import { useRemoteCatalog } from "../../state/use-remote-catalog";
import {
  useRemoteConnectionStatus,
  useRemoteEnvironmentState,
} from "../../state/use-remote-environment-registry";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { useThreadSelection } from "../../state/use-thread-selection";
import { GitActionProgressOverlay } from "./GitActionProgressOverlay";
import { ThreadDetailScreen } from "./ThreadDetailScreen";
import { ThreadGitControls } from "./ThreadGitControls";
import { ThreadNavigationDrawer } from "./ThreadNavigationDrawer";
import { useSelectedThreadCommands } from "./use-selected-thread-commands";
import { useSelectedThreadGitActions } from "./use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "./use-selected-thread-git-state";
import { useThreadComposerState } from "./use-thread-composer-state";

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
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
  const composer = useThreadComposerState();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const commands = useSelectedThreadCommands({
    activePendingUserInput: composer.activePendingUserInput,
    activePendingUserInputAnswers: composer.activePendingUserInputAnswers,
    refreshSelectedThreadGitStatus: gitActions.refreshSelectedThreadGitStatus,
  });
  const refreshSelectedThread = commands.onRefresh;
  const router = useRouter();
  const params = useLocalSearchParams<{
    environmentId?: string | string[];
    threadId?: string | string[];
  }>();
  const [drawerVisible, setDrawerVisible] = useState(false);
  const environmentId = firstRouteParam(params.environmentId);
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
  const gitStatus = useGitStatus({
    environmentId: selectedThread?.environmentId ?? "",
    cwd: selectedThread?.worktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
  });

  /* ─── Git action progress (for overlay banner) ──────────────────── */
  const gitActionProgressTarget = useMemo(
    () => ({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThread?.worktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
    }),
    [
      selectedThread?.environmentId,
      selectedThread?.worktreePath,
      selectedThreadProject?.workspaceRoot,
    ],
  );
  const gitActionProgress = useGitActionProgress(gitActionProgressTarget);

  const handleRefreshGitStatus = useCallback(async () => {
    if (!selectedThread) return;
    await gitStatusManager.refresh({
      environmentId: selectedThread.environmentId,
      cwd: selectedThread.worktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
    });
  }, [selectedThread, selectedThreadProject?.workspaceRoot]);

  /** Wraps thread refresh + git status refresh for pull-to-refresh */
  const handleRefreshAll = useCallback(async () => {
    await refreshSelectedThread();
    await handleRefreshGitStatus();
  }, [handleRefreshGitStatus, refreshSelectedThread]);

  const handleOpenDrawer = useCallback(() => {
    setDrawerVisible(true);
  }, []);

  const handleOpenConnectionEditor = useCallback(() => {
    void router.push("/connections");
  }, [router]);

  if (!environmentId || !threadId) {
    return <LoadingScreen message="Opening thread…" />;
  }

  if (!selectedThread) {
    const stillHydrating =
      isLoadingSavedConnection ||
      routeConnectionState === "connecting" ||
      routeConnectionState === "reconnecting";

    if (stillHydrating) {
      return <LoadingScreen message="Opening thread…" />;
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
    return <LoadingScreen message="Opening thread…" />;
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
          activePendingApproval={composer.activePendingApproval}
          respondingApprovalId={commands.respondingApprovalId}
          activePendingUserInput={composer.activePendingUserInput}
          activePendingUserInputDrafts={composer.activePendingUserInputDrafts}
          activePendingUserInputAnswers={composer.activePendingUserInputAnswers}
          respondingUserInputId={commands.respondingUserInputId}
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
          onRefresh={handleRefreshAll}
          serverConfig={serverConfig}
          onStopThread={commands.onStopThread}
          onSendMessage={composer.onSendMessage}
          onUpdateThreadModelSelection={commands.onUpdateThreadModelSelection}
          onUpdateThreadRuntimeMode={commands.onUpdateThreadRuntimeMode}
          onUpdateThreadInteractionMode={commands.onUpdateThreadInteractionMode}
          onRespondToApproval={commands.onRespondToApproval}
          onSelectUserInputOption={composer.onSelectUserInputOption}
          onChangeUserInputCustomAnswer={composer.onChangeUserInputCustomAnswer}
          onSubmitUserInput={commands.onSubmitUserInput}
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
