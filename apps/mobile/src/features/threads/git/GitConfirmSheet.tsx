import { resolveDefaultBranchActionDialogCopy } from "@t3tools/client-runtime/state/vcs";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/AppText";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { SheetActionButton } from "./gitSheetComponents";

type GitConfirmSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly confirmAction?: string;
  readonly branchName?: string;
  readonly includesCommit?: string;
  readonly commitMessage?: string;
  readonly filePaths?: string;
}>;

export function GitConfirmSheet(props: GitConfirmSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();

  const params = props.route.params;

  const confirmAction = params.confirmAction as
    | "push"
    | "create_pr"
    | "commit_push"
    | "commit_push_pr"
    | undefined;
  const branchName = params.branchName ?? "";
  const includesCommit = params.includesCommit === "true";
  const environmentId = params.environmentId ?? "";
  const threadId = params.threadId ?? "";

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
    navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId }));
    await gitActions.onRunSelectedThreadGitAction({
      action: confirmAction,
      ...(params.commitMessage ? { commitMessage: params.commitMessage } : {}),
      ...(params.filePaths ? { filePaths: params.filePaths.split(",") } : {}),
    });
  }, [confirmAction, environmentId, gitActions, params, navigation, threadId]);

  const movePendingActionToFeatureBranch = useCallback(async () => {
    if (!confirmAction) return;
    navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId }));

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
      Arr.filterMap(branches, (branch) =>
        branch.isRemote ? Result.failVoid : Result.succeed(branch.name),
      ),
    );
    await gitActions.onCreateSelectedThreadBranch(newBranchName);
    await gitActions.onRunSelectedThreadGitAction({ action: confirmAction });
  }, [
    confirmAction,
    gitActions,
    gitState.selectedThreadBranches,
    includesCommit,
    params,
    navigation,
    environmentId,
    threadId,
  ]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <View style={{ minHeight: 16, paddingTop: 8 }} />

      <View className="items-center gap-1 px-5 pb-3 pt-4">
        <Text
          className="text-xs font-t3-bold uppercase text-foreground-muted"
          style={{ letterSpacing: 1 }}
        >
          Confirm
        </Text>
        <Text className="text-center text-3xl font-t3-bold">
          {copy?.title ?? "Run action on default branch?"}
        </Text>
        <Text className="text-center text-foreground-secondary text-sm font-medium leading-normal">
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
