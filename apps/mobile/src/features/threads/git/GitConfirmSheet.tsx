import { resolveDefaultBranchActionDialogCopy } from "@t3tools/client-runtime/state/vcs";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useMemo } from "react";
import { Platform, View } from "react-native";

import { SheetHeader } from "../../../components/ui/SheetHeader";
import { FitSheet } from "../../../components/ui/FitSheet";
import { AppText as Text } from "../../../components/ui/AppText";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useThreadSelection } from "../../../state/use-thread-selection";
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
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const { canWriteSourceControl, canChangeThreadBranch } = gitActions;
  const { selectedThreadProject } = useThreadSelection();
  const terminology = sourceControlClients.get(
    selectedThreadProject?.repositoryIdentity?.provider,
  ).changeRequest;

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
            terminology,
          })
        : null,
    [branchName, confirmAction, includesCommit, terminology],
  );

  const continuePendingAction = async () => {
    if (!canWriteSourceControl || !confirmAction) return;
    navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId }));
    await gitActions.onRunSelectedThreadGitAction({
      action: confirmAction,
      ...(params.commitMessage ? { commitMessage: params.commitMessage } : {}),
      ...(params.filePaths ? { filePaths: params.filePaths.split(",") } : {}),
    });
  };

  const movePendingActionToFeatureBranch = useCallback(async () => {
    if (!canChangeThreadBranch || !confirmAction) return;
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
    if (branches === null) return;
    const newBranchName = resolveAutoFeatureBranchName(
      Arr.filterMap(branches, (branch) =>
        branch.isRemote ? Result.failVoid : Result.succeed(branch.name),
      ),
    );
    const created = await gitActions.onCreateSelectedThreadBranch(newBranchName);
    if (created === null) return;
    await gitActions.onRunSelectedThreadGitAction({ action: confirmAction });
  }, [
    canChangeThreadBranch,
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
    <FitSheet
      header={<SheetHeader title="Confirm action" onClose={() => navigation.goBack()} />}
      showsVerticalScrollIndicator={false}
      contentContainerClassName="android:gap-2 android:p-2"
    >
      <View className="android:gap-2 android:rounded-[20px] android:bg-card android:p-3 ios:items-center ios:gap-1 ios:px-5 ios:pb-3 ios:pt-4">
        {Platform.OS !== "android" ? (
          <Text className="text-xs font-t3-bold tracking-[1px] uppercase text-foreground-muted">
            Confirm
          </Text>
        ) : null}
        <Text className="android:text-xl android:font-t3-medium ios:text-center ios:text-3xl ios:font-t3-bold">
          {copy?.title ?? "Run action on default branch?"}
        </Text>
        <Text className="text-foreground-secondary leading-normal android:text-base ios:text-center ios:text-sm ios:font-medium">
          {copy?.description ?? "Choose how to continue."}
        </Text>
      </View>

      <View className="android:gap-2 ios:gap-3 ios:px-5 ios:pt-2">
        <SheetActionButton
          icon="arrow.right.circle"
          label={copy?.continueLabel ?? "Continue"}
          disabled={!canWriteSourceControl}
          onPress={() => void continuePendingAction()}
        />
        <SheetActionButton
          icon="arrow.branch"
          label="Feature branch & continue"
          disabled={!canChangeThreadBranch}
          tone="primary"
          onPress={() => void movePendingActionToFeatureBranch()}
        />
      </View>
    </FitSheet>
  );
}
