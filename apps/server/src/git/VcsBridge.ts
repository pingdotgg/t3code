import {
  GitCommandError,
  VcsProcessExitError,
  type GitBranch,
  type GitCheckoutResult,
  type GitCreateBranchResult,
  type GitCreateWorktreeResult,
  type GitListBranchesInput,
  type GitListBranchesResult,
  type GitPullResult,
  type GitStatusLocalResult,
  type GitStatusRemoteResult,
  type GitStatusResult,
  type GitStatusStreamEvent,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsError,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsPullResult,
  type VcsRef,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
  type VcsStatusStreamEvent,
  type VcsSwitchRefResult,
} from "@t3tools/contracts";

/**
 * Pure mappers bridging the fork's git-based domain model onto the upstream
 * version-control-system (VCS) contracts consumed by the React Native client.
 *
 * The fork is git-first, so every VCS RPC is served by delegating to the
 * existing git layers and translating the result shape here. Keeping the
 * translation in one module avoids scattering field renames across ws.ts.
 */

export const gitStatusLocalToVcs = (local: GitStatusLocalResult): VcsStatusLocalResult => ({
  isRepo: local.isRepo,
  hasPrimaryRemote: local.hasOriginRemote,
  isDefaultRef: local.isDefaultBranch,
  refName: local.branch,
  hasWorkingTreeChanges: local.hasWorkingTreeChanges,
  workingTree: local.workingTree,
});

export const gitStatusRemoteToVcs = (remote: GitStatusRemoteResult): VcsStatusRemoteResult => ({
  hasUpstream: remote.hasUpstream,
  aheadCount: remote.aheadCount,
  behindCount: remote.behindCount,
  pr:
    remote.pr === null
      ? null
      : {
          number: remote.pr.number,
          title: remote.pr.title,
          url: remote.pr.url,
          baseRef: remote.pr.baseBranch,
          headRef: remote.pr.headBranch,
          state: remote.pr.state,
        },
});

export const gitStatusToVcs = (status: GitStatusResult): VcsStatusResult => ({
  ...gitStatusLocalToVcs(status),
  ...gitStatusRemoteToVcs(status),
});

export const gitStatusStreamEventToVcs = (event: GitStatusStreamEvent): VcsStatusStreamEvent => {
  switch (event._tag) {
    case "snapshot":
      return {
        _tag: "snapshot",
        local: gitStatusLocalToVcs(event.local),
        remote: event.remote === null ? null : gitStatusRemoteToVcs(event.remote),
      };
    case "localUpdated":
      return { _tag: "localUpdated", local: gitStatusLocalToVcs(event.local) };
    case "remoteUpdated":
      return {
        _tag: "remoteUpdated",
        remote: event.remote === null ? null : gitStatusRemoteToVcs(event.remote),
      };
  }
};

export const gitBranchToVcsRef = (branch: GitBranch): VcsRef => ({
  name: branch.name,
  ...(branch.isRemote !== undefined ? { isRemote: branch.isRemote } : {}),
  ...(branch.remoteName !== undefined ? { remoteName: branch.remoteName } : {}),
  current: branch.current,
  isDefault: branch.isDefault,
  worktreePath: branch.worktreePath,
});

export const gitListBranchesToVcs = (result: GitListBranchesResult): VcsListRefsResult => ({
  refs: result.branches.map(gitBranchToVcsRef),
  isRepo: result.isRepo,
  hasPrimaryRemote: result.hasOriginRemote,
  nextCursor: result.nextCursor,
  totalCount: result.totalCount,
});

export const vcsListRefsInputToGit = (input: VcsListRefsInput): GitListBranchesInput => ({
  cwd: input.cwd,
  ...(input.query !== undefined ? { query: input.query } : {}),
  ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  ...(input.limit !== undefined ? { limit: input.limit } : {}),
});

export const vcsCreateWorktreeInputToGit = (input: VcsCreateWorktreeInput) => ({
  cwd: input.cwd,
  branch: input.refName,
  ...(input.newRefName !== undefined ? { newBranch: input.newRefName } : {}),
  path: input.path,
});

export const gitCreateWorktreeResultToVcs = (
  result: GitCreateWorktreeResult,
): VcsCreateWorktreeResult => ({
  worktree: {
    path: result.worktree.path,
    refName: result.worktree.branch,
  },
});

export const vcsCreateRefInputToGit = (input: VcsCreateRefInput) => ({
  cwd: input.cwd,
  branch: input.refName,
  ...(input.switchRef !== undefined ? { checkout: input.switchRef } : {}),
});

export const gitCreateBranchResultToVcs = (result: GitCreateBranchResult): VcsCreateRefResult => ({
  refName: result.branch,
});

export const gitCheckoutResultToVcs = (result: GitCheckoutResult): VcsSwitchRefResult => ({
  refName: result.branch,
});

export const gitPullResultToVcs = (result: GitPullResult): VcsPullResult => ({
  status: result.status,
  refName: result.branch,
  upstreamRef: result.upstreamBranch,
});

/**
 * Surface a git command failure through the VCS error channel so VCS-typed RPCs
 * (e.g. vcs.init) keep a single, predictable error contract for the client.
 */
export const gitCommandErrorToVcs = (error: GitCommandError): VcsError =>
  new VcsProcessExitError({
    operation: error.operation,
    command: error.command,
    cwd: error.cwd,
    exitCode: 1,
    detail: error.detail,
  });
