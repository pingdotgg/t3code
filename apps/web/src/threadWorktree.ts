import type { GitBranch, NativeApi } from "@t3tools/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { invalidateGitQueries } from "./lib/gitReactQuery";

const WORKTREE_BRANCH_PREFIX = "t3code";

export function buildTemporaryWorktreeBranchName(): string {
  const token = crypto.randomUUID().slice(0, 8).toLowerCase();
  return `${WORKTREE_BRANCH_PREFIX}/${token}`;
}

export function resolveDefaultLocalBranch(branches: ReadonlyArray<GitBranch>): string | null {
  const localBranches = branches.filter((branch) => !branch.isRemote);
  return (
    localBranches.find((branch) => branch.isDefault)?.name ??
    localBranches.find((branch) => branch.current)?.name ??
    null
  );
}

export async function createDedicatedThreadWorkspace(input: {
  api: NativeApi;
  cwd: string;
  preferredBaseBranch?: string | null;
  queryClient?: QueryClient;
}): Promise<{
  repoRoot: string;
  baseBranch: string;
  branch: string;
  worktreePath: string;
}> {
  const repositoryContext = await input.api.git.repositoryContext({ cwd: input.cwd });
  const repoRoot = repositoryContext.repoRoot;
  if (!repositoryContext.isRepo || !repoRoot) {
    throw new Error("Git worktree creation is unavailable.");
  }

  const branchesResult = await input.api.git.listBranches({ cwd: repoRoot });
  const baseBranch = input.preferredBaseBranch ?? resolveDefaultLocalBranch(branchesResult.branches);
  if (!baseBranch) {
    throw new Error("Select a base branch before using Dedicated mode.");
  }

  const result = await input.api.git.createWorktree({
    cwd: repoRoot,
    branch: baseBranch,
    newBranch: buildTemporaryWorktreeBranchName(),
    path: null,
  });

  if (input.queryClient) {
    await invalidateGitQueries(input.queryClient);
  }

  return {
    repoRoot,
    baseBranch,
    branch: result.worktree.branch,
    worktreePath: result.worktree.path,
  };
}
