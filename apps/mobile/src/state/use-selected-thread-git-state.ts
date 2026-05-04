import { useMemo } from "react";

import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";

import { useGitActionState } from "./use-git-action-state";
import { useGitBranches } from "./use-git-branches";
import { useSourceControlDiscovery } from "./use-source-control-discovery";
import { useThreadSelection } from "./use-thread-selection";
import { useSelectedThreadWorktree } from "./use-selected-thread-worktree";

export function useSelectedThreadGitState() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();

  const selectedThreadGitTarget = useMemo(
    () => ({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadCwd,
    }),
    [selectedThread?.environmentId, selectedThreadCwd],
  );
  const gitActionState = useGitActionState(selectedThreadGitTarget);
  const sourceControlDiscovery = useSourceControlDiscovery(selectedThread?.environmentId ?? null);

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
    sourceControlDiscovery,
    selectedThreadBranches,
    selectedThreadBranchesLoading: selectedThreadBranchState.isPending,
  };
}
