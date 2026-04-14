import {
  type GitActionRequestInput,
  buildMenuItems,
  getGitActionDisabledReason,
  requiresDefaultBranchConfirmation,
} from "@t3tools/client-runtime";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo } from "react";
import { Alert, Linking, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../../lib/useThemeColor";

import { AppText as Text } from "../../../components/AppText";
import { buildThreadReviewRoutePath } from "../../../lib/routes";
import { useGitStatus } from "../../../state/use-git-status";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../use-selected-thread-git-state";
import { MetaCard, SheetListRow, menuItemIconName, statusSummary } from "./gitSheetComponents";

export function GitOverviewSheet() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { environmentId, threadId } = useLocalSearchParams<{
    environmentId: string;
    threadId: string;
  }>();
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();

  const iconColor = useThemeColor("--color-icon");
  const borderColor = useThemeColor("--color-border");

  const gitStatus = useGitStatus({
    environmentId: selectedThread?.environmentId ?? "",
    cwd: selectedThread?.worktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
  });

  const currentBranchLabel = gitStatus.data?.branch ?? selectedThread?.branch ?? "Detached HEAD";
  const currentWorktreePath = selectedThread?.worktreePath ?? null;
  const gitOperationLabel = gitState.gitOperationLabel;
  const busy = gitOperationLabel !== null;
  const isRepo = gitStatus.data?.isRepo ?? true;
  const hasOriginRemote = gitStatus.data?.hasOriginRemote ?? false;
  const isDefaultBranch = gitStatus.data?.isDefaultBranch ?? false;

  const menuItems = useMemo(
    () => (isRepo ? buildMenuItems(gitStatus.data, busy, hasOriginRemote) : []),
    [busy, gitStatus.data, hasOriginRemote, isRepo],
  );

  const sheetMenuItems = useMemo(
    () =>
      menuItems.map((item) => ({
        item,
        disabledReason: getGitActionDisabledReason({
          item,
          gitStatus: gitStatus.data,
          isBusy: busy,
          hasOriginRemote,
        }),
      })),
    [busy, gitStatus.data, hasOriginRemote, menuItems],
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
    try {
      await Linking.openURL(prUrl);
    } catch (error) {
      Alert.alert(
        "Unable to open PR",
        error instanceof Error ? error.message : "An error occurred.",
      );
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
      const branchName = gitStatus.data?.branch;
      if (
        branchName &&
        confirmableAction &&
        !input.featureBranch &&
        requiresDefaultBranchConfirmation(input.action, isDefaultBranch)
      ) {
        router.push({
          pathname: "/threads/[environmentId]/[threadId]/git-confirm",
          params: {
            environmentId,
            threadId,
            confirmAction: confirmableAction,
            branchName,
            includesCommit: String(
              input.action === "commit_push" || input.action === "commit_push_pr",
            ),
          },
        });
        return;
      }

      router.dismiss();
      await gitActions.onRunSelectedThreadGitAction(input);
    },
    [environmentId, gitActions, gitStatus.data, isDefaultBranch, router, threadId],
  );

  const onPressMenuItem = useCallback(
    async (item: (typeof menuItems)[number]) => {
      if (item.disabled) return;
      if (item.kind === "open_pr") {
        await openExistingPr();
        return;
      }
      if (item.dialogAction === "commit") {
        router.push({
          pathname: "/threads/[environmentId]/[threadId]/git/commit",
          params: { environmentId, threadId },
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
    [environmentId, openExistingPr, router, runActionWithPrompt, threadId],
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <View style={{ minHeight: 16, paddingTop: 8 }} />

      <View className="items-center gap-1 px-5 pb-3 pt-4">
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
          className="text-[12px] font-t3-bold uppercase text-foreground-muted"
          style={{ letterSpacing: 1 }}
        >
          Branch
        </Text>
        <Text className="text-[28px] font-t3-bold">{currentBranchLabel}</Text>
        <Text className="text-foreground-secondary text-[13px] font-medium leading-[19px]">
          {statusSummary(gitStatus.data)}
        </Text>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          gap: 14,
        }}
      >
        <View className="overflow-hidden rounded-[22px] border border-border bg-card px-4 py-1">
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
            onPress={() => router.push(buildThreadReviewRoutePath({ environmentId, threadId }))}
          />
          <View className="ml-12 h-px" style={{ backgroundColor: borderColor }} />
          <SheetListRow
            icon="point.topleft.down.curvedto.point.bottomright.up"
            title="Branches & worktrees"
            subtitle="Switch branch, create branch, or move to a worktree"
            disabled={busy || !isRepo}
            onPress={() =>
              router.push({
                pathname: "/threads/[environmentId]/[threadId]/git/branches",
                params: { environmentId, threadId },
              })
            }
          />
        </View>

        {currentWorktreePath ? <MetaCard label="Worktree" value={currentWorktreePath} /> : null}
      </ScrollView>
    </View>
  );
}
