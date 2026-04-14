import { useMemo } from "react";

import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";

import { useGitActionState } from "../../state/use-git-action-state";
import { useGitBranches } from "../../state/use-git-branches";
import { useThreadSelection } from "../../state/use-thread-selection";

export function useSelectedThreadGitState() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();

  const selectedThreadGitTarget = useMemo(
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
  const gitActionState = useGitActionState(selectedThreadGitTarget);

  const selectedThreadBranchTarget = useMemo(
    () => ({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadProject?.workspaceRoot ?? null,
      query: null,
    }),
    [selectedThread?.environmentId, selectedThreadProject?.workspaceRoot],
  );
  const selectedThreadBranchState = useGitBranches(selectedThreadBranchTarget);
  const selectedThreadBranches = useMemo(
    () =>
      dedupeRemoteBranchesWithLocalMatches(selectedThreadBranchState.data?.branches ?? []).filter(
        (branch) => !branch.isRemote,
      ),
    [selectedThreadBranchState.data?.branches],
  );

  return {
    gitOperationLabel: gitActionState.currentLabel,
    selectedThreadBranches,
    selectedThreadBranchesLoading: selectedThreadBranchState.isPending,
  };
}
