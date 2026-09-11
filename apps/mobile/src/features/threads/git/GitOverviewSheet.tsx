import {
  type GitActionRequestInput,
  buildMenuItems,
  getGitActionDisabledReason,
  requiresDefaultBranchConfirmation,
} from "@t3tools/client-runtime/state/vcs";
import {
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
} from "@t3tools/shared/threadPullRequests";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  CommonActions,
  StackActions,
  useNavigation,
  useFocusEffect,
  type StaticScreenProps,
} from "@react-navigation/native";
import { SymbolView } from "../../../components/AppSymbol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";

import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useUniwindTheme } from "../../../lib/useUniwindTheme";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { AppText as Text } from "../../../components/AppText";
import { nativeHeaderScrollEdgeEffects } from "../../../native/StackHeader";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useWorkspaceRepositories } from "../../../state/use-workspace-repositories";
import { vcsEnvironment } from "../../../state/vcs";
import { resolveGitOverviewReviewNavigationAction } from "./git-overview-navigation";
import { MetaCard, SheetListRow, menuItemIconName, statusSummary } from "./gitSheetComponents";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type GitOverviewSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}> & {
  readonly headerInset?: number;
  readonly presentation?: "sheet" | "inspector";
};

export function GitOverviewSheet(props: GitOverviewSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const presentation = props.presentation ?? "sheet";
  const isInspector = presentation === "inspector";
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const { selectedThread, selectedEnvironmentRuntime } = useThreadSelection();
  const {
    selectedThreadCwd,
    selectedThreadWorktreePath,
    repositories,
    selectedPath,
    selectRepository,
    refreshRepositories,
    repositoryError,
  } = useWorkspaceRepositories();
  const supportsLinkedPrSnapshots =
    selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.threadPullRequests === true;
  const linkedPrChains = useMemo(
    () =>
      resolveThreadPullRequestChains(
        supportsLinkedPrSnapshots ? (selectedThread?.pullRequests ?? []) : [],
      ),
    [selectedThread?.pullRequests, supportsLinkedPrSnapshots],
  );
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  useFocusEffect(
    useCallback(() => {
      refreshRepositories();
    }, [refreshRepositories]),
  );
  const theme = useUniwindTheme();
  const foregroundColor = theme["--color-foreground"];
  const sheetColor = theme["--color-sheet"];

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );

  const currentBranchLabel = gitStatus.data?.refName ?? selectedThread?.branch ?? "Detached HEAD";
  const currentStatusSummary = statusSummary(gitStatus.data);
  const currentWorktreePath = selectedThreadWorktreePath;
  const gitOperationLabel = gitState.gitOperationLabel;
  const busy = gitOperationLabel !== null;
  const isRepo = gitStatus.data?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus.data?.hasPrimaryRemote ?? false;
  const isDefaultRef = gitStatus.data?.isDefaultRef ?? false;

  const menuItems = useMemo(
    () => (isRepo ? buildMenuItems(gitStatus.data, busy, hasPrimaryRemote) : []),
    [busy, gitStatus.data, hasPrimaryRemote, isRepo],
  );

  const sheetMenuItems = useMemo(
    () =>
      menuItems.map((item) => ({
        item,
        disabledReason: getGitActionDisabledReason({
          item,
          gitStatus: gitStatus.data,
          isBusy: busy,
          hasOriginRemote: hasPrimaryRemote,
        }),
      })),
    [busy, gitStatus.data, hasPrimaryRemote, menuItems],
  );

  useEffect(() => {
    void gitActions.refreshSelectedThreadGitStatus({ quiet: true });
  }, [gitActions]);

  const openExistingPr = useCallback(async () => {
    const prUrl = gitStatus.data?.pr?.state === "open" ? gitStatus.data.pr.url : null;
    if (!prUrl) {
      Alert.alert("No open PR", "This branch does not have an open pull request.");
      return;
    }
    if (!(await tryOpenExternalUrl(prUrl, "pull-request"))) {
      Alert.alert("Unable to open PR", "The pull request could not be opened.");
    }
  }, [gitStatus.data]);

  const runActionWithPrompt = useCallback(
    async (input: GitActionRequestInput) => {
      const confirmableAction =
        input.action === "push" ||
        input.action === "create_pr" ||
        input.action === "commit_push" ||
        input.action === "commit_push_pr"
          ? input.action
          : null;
      const branchName = gitStatus.data?.refName;
      if (
        branchName &&
        confirmableAction &&
        !input.featureBranch &&
        requiresDefaultBranchConfirmation(input.action, isDefaultRef)
      ) {
        navigation.navigate("GitConfirm", {
          environmentId: String(environmentId),
          threadId: String(threadId),
          confirmAction: confirmableAction,
          branchName,
          includesCommit: String(
            input.action === "commit_push" || input.action === "commit_push_pr",
          ),
        });
        return;
      }

      if (!isInspector) {
        navigation.goBack();
      }
      await gitActions.onRunSelectedThreadGitAction(input);
    },
    [environmentId, gitActions, gitStatus.data, isDefaultRef, isInspector, navigation, threadId],
  );

  const onPressMenuItem = useCallback(
    async (item: (typeof menuItems)[number]) => {
      if (item.disabled) return;
      if (item.kind === "open_pr") {
        await openExistingPr();
        return;
      }
      if (item.dialogAction === "commit") {
        navigation.navigate("GitCommit", {
          environmentId: String(environmentId),
          threadId: String(threadId),
        });
        return;
      }
      if (item.dialogAction === "push") {
        await runActionWithPrompt({ action: "push" });
        return;
      }
      if (item.dialogAction === "create_pr") {
        await runActionWithPrompt({ action: "create_pr" });
      }
    },
    [environmentId, openExistingPr, navigation, runActionWithPrompt, threadId],
  );

  // Status facts live on the relevant rows instead of crowding the header
  // subtitle: files changed → Commit, ahead → Push, PR → View PR, behind → Pull.
  const rowStatusDetail = useCallback(
    (item: (typeof menuItems)[number]): string | undefined => {
      const status = gitStatus.data;
      if (status == null) {
        return undefined;
      }
      if (item.dialogAction === "commit" && status.hasWorkingTreeChanges) {
        const fileCount = status.workingTree?.files.length ?? 0;
        return `${fileCount} file${fileCount === 1 ? "" : "s"} changed`;
      }
      if (item.dialogAction === "push" && (status.aheadCount ?? 0) > 0) {
        const ahead = status.aheadCount ?? 0;
        return `${ahead} commit${ahead === 1 ? "" : "s"} ahead`;
      }
      if (item.kind === "open_pr" && status.pr?.number != null) {
        return `PR #${status.pr.number} ${status.pr.state ?? "open"}`;
      }
      return undefined;
    },
    [gitStatus.data, menuItems],
  );

  const behindCount = gitStatus.data?.behindCount ?? 0;

  // Deterministic pull-to-refresh state. Tying RefreshControl to the query's
  // isPending flag left the spinner stuck (the status query reports pending
  // during quiet background refreshes too).
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const handlePullRefresh = useCallback(async () => {
    setIsPullRefreshing(true);
    try {
      await gitActions.refreshSelectedThreadGitStatus();
    } finally {
      setIsPullRefreshing(false);
    }
  }, [gitActions]);

  const content = (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      showsVerticalScrollIndicator={false}
      contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
      contentContainerStyle={{
        paddingHorizontal: isInspector ? 12 : 20,
        paddingTop: 8,
        gap: 14,
      }}
      refreshControl={
        <RefreshControl refreshing={isPullRefreshing} onRefresh={() => void handlePullRefresh()} />
      }
    >
      {repositoryError ? <Text>{repositoryError}</Text> : null}
      {repositories.length > 1 || (repositories.length === 1 && selectedPath !== ".") ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {repositories.map((repository) => (
            <Pressable
              key={repository.path}
              accessibilityRole="button"
              accessibilityState={{
                selected: selectedPath === repository.path,
                disabled: busy || !repository.available,
              }}
              disabled={busy || !repository.available}
              onPress={() => selectRepository(repository.path)}
              className="mr-2 rounded-xl border border-border bg-card px-3 py-2"
            >
              <Text>
                {selectedPath === repository.path ? "✓ " : ""}
                {repository.path === "." ? "Workspace" : repository.path}
                {repository.available ? "" : " (unavailable)"}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <View
        className={
          isInspector
            ? "overflow-hidden rounded-2xl border border-border bg-card px-3 py-1"
            : "overflow-hidden rounded-[22px] border border-border bg-card px-4 py-1"
        }
      >
        {sheetMenuItems.map(({ item, disabledReason }, index) => (
          <View key={`${item.id}-${item.label}`}>
            {index > 0 ? <View className="ml-12 h-px bg-border" /> : null}
            <SheetListRow
              icon={menuItemIconName(item.icon)}
              title={item.label}
              subtitle={disabledReason ?? rowStatusDetail(item)}
              disabled={item.disabled}
              onPress={() => void onPressMenuItem(item)}
            />
          </View>
        ))}
        {behindCount > 0 ? (
          <>
            <View className="ml-12 h-px bg-border" />
            <SheetListRow
              icon="arrow.down.circle"
              title="Pull latest"
              subtitle={`${behindCount} commit${behindCount === 1 ? "" : "s"} behind upstream`}
              disabled={busy || !isRepo}
              onPress={() => void gitActions.onPullSelectedThreadBranch()}
            />
          </>
        ) : null}
        <View className="ml-12 h-px bg-border" />
        <SheetListRow
          icon="text.bubble"
          title="Review changes"
          subtitle="Inspect turn diffs, worktree changes, and base branch diff"
          disabled={busy || !isRepo}
          onPress={() => {
            const params = { environmentId, threadId };
            navigation.dispatch(
              resolveGitOverviewReviewNavigationAction(presentation) === "replace"
                ? StackActions.replace("ThreadReview", params)
                : CommonActions.navigate("ThreadReview", params),
            );
          }}
        />
        <View className="ml-12 h-px bg-border" />
        <SheetListRow
          icon="point.topleft.down.curvedto.point.bottomright.up"
          title="Branches & worktrees"
          subtitle="Switch branch, create branch, or move to a worktree"
          disabled={busy || !isRepo}
          onPress={() =>
            navigation.navigate("GitBranches", {
              environmentId: String(environmentId),
              threadId: String(threadId),
            })
          }
        />
      </View>

      {linkedPrChains.length > 0 ? (
        <View className="gap-2">
          <Text className="px-1 text-xs font-t3-bold text-foreground-muted">
            Linked pull requests
          </Text>
          {linkedPrChains.map((chain) => (
            <View
              key={threadPullRequestKeyOf(chain.layers[0]!)}
              className="overflow-hidden rounded-2xl border border-border bg-card px-3 py-1"
            >
              {chain.layers.length > 1 ? (
                <View className="flex-row items-center gap-2 px-1 pt-2 pb-1">
                  <SymbolView
                    name="square.3.layers.3d"
                    size={14}
                    tintColorClassName="accent-foreground-muted"
                  />
                  <Text className="text-xs text-foreground-muted">
                    {chain.kind === "native" ? "Stack" : "Branch stack"} · {chain.layers.length} PRs
                    · bottom to top
                  </Text>
                </View>
              ) : null}
              {chain.layers.map((link, index) => (
                <View key={threadPullRequestKeyOf(link)}>
                  {index > 0 ? <View className="ml-12 h-px bg-border" /> : null}
                  <SheetListRow
                    icon="arrow.triangle.pull"
                    title={`#${link.number} ${link.snapshot?.title ?? "Pull request"}`}
                    subtitle={`${link.repository} · ${link.snapshot === null ? "Status pending" : link.snapshot.isDraft && link.snapshot.state === "open" ? "Draft" : link.snapshot.state}`}
                    onPress={() => {
                      void tryOpenExternalUrl(link.url, "pull-request").then((opened) => {
                        if (!opened)
                          Alert.alert("Unable to open PR", "The pull request could not be opened.");
                      });
                    }}
                  />
                </View>
              ))}
            </View>
          ))}
        </View>
      ) : null}

      {currentWorktreePath ? <MetaCard label="Worktree" value={currentWorktreePath} /> : null}
    </ScrollView>
  );

  if (isInspector && Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 border-l border-border bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-git-inspector-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: sheetColor, flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={foregroundColor}
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              title={currentBranchLabel}
              titleColor={foregroundColor}
              titleFontSize={17}
              titleFontWeight="700"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  if (Platform.OS === "ios") {
    // Compact form sheet: a plain screen presented as formSheet never renders a
    // stack header, so — like the Settings sheet — the header must come from a
    // nested native stack INSIDE the sheet. This reuses the exact structure of the
    // inspector branch below: branch as the title, status summary as the native
    // subtitle, refresh as a header button.
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-git-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: sheetColor, flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={foregroundColor}
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              title={currentBranchLabel}
              titleColor={foregroundColor}
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View
      collapsable={false}
      className={isInspector ? "flex-1 border-l border-border bg-sheet" : "flex-1 bg-sheet"}
    >
      {isInspector ? (
        <View
          style={{
            minHeight: props.headerInset ?? 0,
            paddingTop: props.headerInset ?? 0,
          }}
        />
      ) : null}

      {isInspector ? (
        <View className="gap-1 border-b border-border px-4 pb-4 pt-3">
          <Pressable
            className={
              busy
                ? "absolute right-3 top-4 z-[1] h-9 w-9 items-center justify-center rounded-full bg-subtle opacity-[0.45]"
                : "absolute right-3 top-4 z-[1] h-9 w-9 items-center justify-center rounded-full bg-subtle"
            }
            disabled={busy}
            onPress={() => void gitActions.refreshSelectedThreadGitStatus()}
          >
            <SymbolView
              name="arrow.clockwise"
              size={16}
              tintColorClassName={"accent-icon"}
              type="monochrome"
              weight="medium"
            />
          </Pressable>
          <Text className="text-xs font-t3-bold tracking-[1px] uppercase text-foreground-muted">
            Repository
          </Text>
          <Text className="pr-10 text-xl font-t3-bold">{currentBranchLabel}</Text>
          <Text className="text-foreground-secondary text-sm font-medium leading-normal">
            {currentStatusSummary}
          </Text>
        </View>
      ) : (
        <AndroidSheetHeader
          title={currentBranchLabel}
          subtitle={currentStatusSummary}
          onBack={() => navigation.goBack()}
          actions={[
            {
              accessibilityLabel: "Refresh repository status",
              disabled: busy,
              icon: "arrow.clockwise",
              onPress: () => void gitActions.refreshSelectedThreadGitStatus(),
            },
          ]}
        />
      )}

      {content}
    </View>
  );
}
