import { resolveDefaultBranchActionDialogCopy } from "@t3tools/client-runtime/state/vcs";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useMemo } from "react";
import { View } from "react-native";

import { SheetHeader } from "../../../components/ui/SheetHeader";
import { FitSheet } from "../../../components/ui/FitSheet";
import { SheetIntro } from "../../../components/ui/SheetIntro";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useEnvironmentQuery } from "../../../state/query";
import {
  gitRepositoryTargetFromRoute,
  type GitRepositoryRouteParams,
} from "../../../state/thread-git-target";
import { vcsEnvironment } from "../../../state/vcs";
import { SheetActionButton } from "./gitSheetComponents";

type GitConfirmSheetProps = StaticScreenProps<
  {
    readonly environmentId: string;
    readonly threadId: string;
    readonly confirmAction?: string;
    readonly branchName?: string;
    readonly includesCommit?: string;
    readonly commitMessage?: string;
    readonly filePaths?: string;
  } & GitRepositoryRouteParams
>;

export function GitConfirmSheet(props: GitConfirmSheetProps) {
  const navigation = useNavigation();
  const repository = gitRepositoryTargetFromRoute(props.route.params);
  const gitState = useSelectedThreadGitState(repository);
  const gitActions = useSelectedThreadGitActions(repository);
  const { canWriteSourceControl, canCreateFeatureBranch } = gitActions;
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  // The overview that opened this sheet already holds the repository's status subscription.
  const repositoryStatus = useEnvironmentQuery(
    repository !== undefined && selectedThread !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: repository.cwd },
        })
      : null,
  );
  const terminology = sourceControlClients.get(
    repository === undefined
      ? selectedThreadProject?.repositoryIdentity?.provider
      : repositoryStatus.data?.sourceControlProvider?.kind,
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
    if (!canCreateFeatureBranch || !confirmAction) return;
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
    canCreateFeatureBranch,
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
    >
      <SheetIntro
        eyebrow="Confirm"
        title={copy?.title ?? "Run action on default branch?"}
        description={copy?.description ?? "Choose how to continue."}
      />

      <View className="gap-3">
        <SheetActionButton
          icon="arrow.right.circle"
          label={copy?.continueLabel ?? "Continue"}
          disabled={!canWriteSourceControl}
          onPress={() => void continuePendingAction()}
        />
        <SheetActionButton
          icon="arrow.branch"
          label="Feature branch & continue"
          disabled={!canCreateFeatureBranch}
          tone="primary"
          onPress={() => void movePendingActionToFeatureBranch()}
        />
      </View>
    </FitSheet>
  );
}
