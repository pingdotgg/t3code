import { vcsActionLabelText } from "@t3tools/client-runtime/state/vcs";
import { useMessages } from "gt-react-native";
import { useMemo } from "react";

import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";

import { useBranches } from "./queries";
import { useEnvironmentQuery } from "./query";
import { sourceControlEnvironment } from "./sourceControl";
import { useVcsTerminology } from "./vcs";
import { useVcsActionState } from "./use-vcs-action-state";
import { useThreadSelection } from "./use-thread-selection";
import { useSelectedThreadWorktree } from "./use-selected-thread-worktree";

export function useSelectedThreadGitState() {
  const messages = useMessages();
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();

  const selectedThreadGitTarget = {
    environmentId: selectedThread?.environmentId ?? null,
    cwd: selectedThreadCwd,
  };
  const gitActionState = useVcsActionState(selectedThreadGitTarget);
  const sourceControlDiscovery = useEnvironmentQuery(
    selectedThread === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId: selectedThread.environmentId,
          input: {},
        }),
  );

  const vcsTerminology = useVcsTerminology(
    selectedThread?.environmentId ?? null,
    selectedThreadCwd,
  );

  const selectedThreadBranchTarget = {
    environmentId: selectedThread?.environmentId ?? null,
    cwd: selectedThreadCwd,
    query: null,
  };
  const selectedThreadBranchState = useBranches(selectedThreadBranchTarget);
  const selectedThreadBranches = useMemo(
    () =>
      dedupeRemoteBranchesWithLocalMatches(selectedThreadBranchState.data?.refs ?? []).filter(
        (branch) => !branch.isRemote,
      ),
    [selectedThreadBranchState.data?.refs],
  );

  return {
    gitOperationLabel: vcsActionLabelText(gitActionState, messages),
    vcsTerminology,
    sourceControlDiscovery,
    selectedThreadBranches,
    selectedThreadBranchesLoading: selectedThreadBranchState.isPending,
  };
}
