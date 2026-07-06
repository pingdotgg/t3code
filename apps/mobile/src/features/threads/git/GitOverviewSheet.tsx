import {
  type GitActionRequestInput,
  buildMenuItems,
  getGitActionDisabledReason,
  requiresDefaultBranchConfirmation,
} from "@t3tools/client-runtime/state/vcs";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../../lib/useThemeColor";

import { AppText as Text } from "../../../components/AppText";
import { nativeHeaderScrollEdgeEffects } from "../../../native/StackHeader";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
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
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd, selectedThreadWorktreePath } = useSelectedThreadWorktree();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();

  const iconColor = useThemeColor("--color-icon");
  const borderColor = useThemeColor("--color-border");
  const foregroundColor = String(useThemeColor("--color-foreground"));
  const sheetColor = String(useThemeColor("--color-sheet"));

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
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      showsVerticalScrollIndicator={false}
      style={{ flex: 1, backgroundColor: sheetColor }}
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
      <View
        className={
          isInspector
            ? "overflow-hidden rounded-2xl border border-border bg-card px-3 py-1"
            : "overflow-hidden rounded-[22px] border border-border bg-card px-4 py-1"
        }
      >
        {sheetMenuItems.map(({ item, disabledReason }, index) => (
          <View key={`${item.id}-${item.label}`}>
            {index > 0 ? (
              <View className="ml-12 h-px" style={{ backgroundColor: borderColor }} />
            ) : null}
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
            <View className="ml-12 h-px" style={{ backgroundColor: borderColor }} />
            <SheetListRow
              icon="arrow.down.circle"
              title="Pull latest"
              subtitle={`${behindCount} commit${behindCount === 1 ? "" : "s"} behind upstream`}
              disabled={busy || !isRepo}
              onPress={() => void gitActions.onPullSelectedThreadBranch()}
            />
          </>
        ) : null}
        <View className="ml-12 h-px" style={{ backgroundColor: borderColor }} />
        <SheetListRow
          icon="text.bubble"
          title="Review changes"
          subtitle="Inspect turn diffs, worktree changes, and base branch diff"
          disabled={busy || !isRepo}
          onPress={() => navigation.navigate("ThreadReview", { environmentId, threadId })}
        />
        <View className="ml-12 h-px" style={{ backgroundColor: borderColor }} />
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
      <View
        style={{
          minHeight: isInspector ? (props.headerInset ?? 0) : 16,
          paddingTop: isInspector ? (props.headerInset ?? 0) : 8,
        }}
      />

      <View
        className={
          isInspector
            ? "gap-1 border-b border-border px-4 pb-4 pt-3"
            : "items-center gap-1 px-5 pb-3 pt-4"
        }
      >
        {/* Android relies on the scroll view's pull-to-refresh instead of a
            floating button; iOS and the inspector keep the corner control. */}
        {Platform.OS === "android" && !isInspector ? null : (
          <Pressable
            className="absolute right-3 top-4 h-9 w-9 items-center justify-center rounded-full bg-subtle"
            style={{ zIndex: 1, opacity: busy ? 0.45 : 1 }}
            disabled={busy}
            onPress={() => void gitActions.refreshSelectedThreadGitStatus()}
          >
            <SymbolView
              name="arrow.clockwise"
              size={16}
              tintColor={iconColor}
              type="monochrome"
              weight="medium"
            />
          </Pressable>
        )}
        <Text
          className="text-xs font-t3-bold uppercase text-foreground-muted"
          style={{ letterSpacing: 1 }}
        >
          {isInspector ? "Repository" : "Branch"}
        </Text>
        <Text className={isInspector ? "pr-10 text-xl font-t3-bold" : "text-3xl font-t3-bold"}>
          {currentBranchLabel}
        </Text>
        <Text className="text-foreground-secondary text-sm font-medium leading-normal">
          {currentStatusSummary}
        </Text>
      </View>

      {content}
    </View>
  );
}
