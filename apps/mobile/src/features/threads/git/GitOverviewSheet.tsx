import {
  type GitActionRequestInput,
  buildMenuItems,
  getGitActionDisabledReason,
  requiresDefaultBranchConfirmation,
} from "@t3tools/client-runtime/state/vcs";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useRouteParams, useAppNavigation } from "../../../navigation/native-stack-header";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, type ComponentProps } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../../lib/useThemeColor";

import { AppText as Text } from "../../../components/AppText";
import { nativeHeaderScrollEdgeEffects } from "../../../lib/native-scroll-edge-effect";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import {
  buildGitBranchesNavigation,
  buildGitCommitNavigation,
  buildGitConfirmNavigation,
  buildThreadReviewNavigation,
} from "../../../lib/routes";
import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { MetaCard, SheetListRow, menuItemIconName, statusSummary } from "./gitSheetComponents";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

export function GitOverviewSheet(
  props: {
    readonly headerInset?: number;
    readonly presentation?: "sheet" | "inspector";
  } = {},
) {
  const navigation = useAppNavigation();
  const insets = useSafeAreaInsets();
  const presentation = props.presentation ?? "sheet";
  const isInspector = presentation === "inspector";
  const { environmentId, threadId } = useRouteParams<{
    environmentId: EnvironmentId;
    threadId: ThreadId;
  }>();
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
        navigation.push(
          buildGitConfirmNavigation(
            { environmentId, threadId },
            {
              confirmAction: confirmableAction,
              branchName,
              includesCommit: String(
                input.action === "commit_push" || input.action === "commit_push_pr",
              ),
            },
          ),
        );
        return;
      }

      if (!isInspector) {
        navigation.dismiss();
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
        navigation.push(buildGitCommitNavigation({ environmentId, threadId }));
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

  const inspectorHeaderRightBarButtonItems = useMemo(
    () =>
      [
        {
          accessibilityLabel: "Refresh repository status",
          disabled: busy,
          icon: { name: "arrow.clockwise", type: "sfSymbol" as const },
          identifier: "git-overview-refresh",
          onPress: () => {
            void gitActions.refreshSelectedThreadGitStatus();
          },
          sharesBackground: false,
          tintColor: foregroundColor,
          type: "button" as const,
          width: 44,
        },
      ] as ComponentProps<typeof ScreenStackHeaderConfig>["headerRightBarButtonItems"],
    [busy, foregroundColor, gitActions],
  );

  const content = (
    <ScrollView
      contentInsetAdjustmentBehavior={isInspector && Platform.OS === "ios" ? "automatic" : "never"}
      showsVerticalScrollIndicator={false}
      style={{ flex: 1 }}
      contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
      contentContainerStyle={{
        paddingHorizontal: isInspector ? 12 : 20,
        paddingTop: 8,
        gap: 14,
      }}
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
              subtitle={disabledReason}
              disabled={item.disabled}
              onPress={() => void onPressMenuItem(item)}
            />
          </View>
        ))}
        {(gitStatus.data?.behindCount ?? 0) > 0 ? (
          <>
            <View className="ml-12 h-px" style={{ backgroundColor: borderColor }} />
            <SheetListRow
              icon="arrow.down.circle"
              title="Pull latest"
              subtitle="Sync this branch with upstream"
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
          onPress={() => navigation.push(buildThreadReviewNavigation({ environmentId, threadId }))}
        />
        <View className="ml-12 h-px" style={{ backgroundColor: borderColor }} />
        <SheetListRow
          icon="point.topleft.down.curvedto.point.bottomright.up"
          title="Branches & worktrees"
          subtitle="Switch branch, create branch, or move to a worktree"
          disabled={busy || !isRepo}
          onPress={() => navigation.push(buildGitBranchesNavigation({ environmentId, threadId }))}
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
              headerRightBarButtonItems={inspectorHeaderRightBarButtonItems}
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              subtitle={currentStatusSummary}
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
        <Text
          className="text-xs font-t3-bold uppercase text-foreground-muted"
          style={{ letterSpacing: 1 }}
        >
          {isInspector ? "Repository" : "Branch"}
        </Text>
        <Text className={isInspector ? "pr-10 text-xl font-t3-bold" : "text-3xl font-t3-bold"}>
          {currentBranchLabel}
        </Text>
        <Text className="text-foreground-secondary text-sm font-medium leading-[19px]">
          {currentStatusSummary}
        </Text>
      </View>

      {content}
    </View>
  );
}
