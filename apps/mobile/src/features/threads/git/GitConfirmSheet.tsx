import { resolveDefaultBranchActionDialogCopy } from "@t3tools/client-runtime";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/AppText";
import { useSelectedThreadGitActions } from "../use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../use-selected-thread-git-state";
import { SheetActionButton } from "./gitSheetComponents";

export function GitConfirmSheet() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();

  const params = useLocalSearchParams<{
    confirmAction?: string;
    branchName?: string;
    includesCommit?: string;
    commitMessage?: string;
    filePaths?: string;
  }>();

  const confirmAction = params.confirmAction as
    | "push"
    | "create_pr"
    | "commit_push"
    | "commit_push_pr"
    | undefined;
  const branchName = params.branchName ?? "";
  const includesCommit = params.includesCommit === "true";

  const copy = useMemo(
    () =>
      confirmAction
        ? resolveDefaultBranchActionDialogCopy({
            action: confirmAction,
            branchName,
            includesCommit,
          })
        : null,
    [branchName, confirmAction, includesCommit],
  );

  const continuePendingAction = useCallback(async () => {
    if (!confirmAction) return;
    router.dismissAll();
    await gitActions.onRunSelectedThreadGitAction({
      action: confirmAction,
      ...(params.commitMessage ? { commitMessage: params.commitMessage } : {}),
      ...(params.filePaths ? { filePaths: params.filePaths.split(",") } : {}),
    });
  }, [confirmAction, gitActions, params, router]);

  const movePendingActionToFeatureBranch = useCallback(async () => {
    if (!confirmAction) return;
    router.dismissAll();

    if (includesCommit) {
      await gitActions.onRunSelectedThreadGitAction({
        action: confirmAction,
        featureBranch: true,
        ...(params.commitMessage ? { commitMessage: params.commitMessage } : {}),
        ...(params.filePaths ? { filePaths: params.filePaths.split(",") } : {}),
      });
      return;
    }

    const branches =
      gitState.selectedThreadBranches.length > 0
        ? gitState.selectedThreadBranches
        : await gitActions.refreshSelectedThreadBranches();
    const newBranchName = resolveAutoFeatureBranchName(
      branches.filter((branch) => !branch.isRemote).map((branch) => branch.name),
    );
    await gitActions.onCreateSelectedThreadBranch(newBranchName);
    await gitActions.onRunSelectedThreadGitAction({ action: confirmAction });
  }, [confirmAction, gitActions, gitState.selectedThreadBranches, includesCommit, params, router]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <View style={{ minHeight: 16, paddingTop: 8 }} />

      <View className="items-center gap-1 px-5 pb-3 pt-4">
        <Text
          className="text-[12px] font-t3-bold uppercase text-foreground-muted"
          style={{ letterSpacing: 1 }}
        >
          Confirm
        </Text>
        <Text className="text-center text-[28px] font-t3-bold">
          {copy?.title ?? "Run action on default branch?"}
        </Text>
        <Text className="text-center text-foreground-secondary text-[13px] font-medium leading-[19px]">
          {copy?.description ?? "Choose how to continue."}
        </Text>
      </View>

      <View
        className="gap-3 px-5"
        style={{ paddingBottom: Math.max(insets.bottom, 18) + 8, paddingTop: 8 }}
      >
        <SheetActionButton
          icon="arrow.right.circle"
          label={copy?.continueLabel ?? "Continue"}
          onPress={() => void continuePendingAction()}
        />
        <SheetActionButton
          icon="arrow.branch"
          label="Feature branch & continue"
          tone="primary"
          onPress={() => void movePendingActionToFeatureBranch()}
        />
      </View>
    </View>
  );
}
