import type { GitStatusResult } from "@t3tools/contracts";

interface ThreadScopedGitStatusInput {
  gitStatus: GitStatusResult | null;
  threadBranch: string | null;
}

export function resolveThreadScopedGitStatus({
  gitStatus,
  threadBranch,
}: ThreadScopedGitStatusInput): GitStatusResult | null {
  if (!gitStatus) return null;

  if (threadBranch === null) {
    return gitStatus.pr === null ? gitStatus : { ...gitStatus, pr: null };
  }

  return gitStatus.branch === threadBranch ? gitStatus : null;
}

export function resolveThreadScopedPr(input: ThreadScopedGitStatusInput): GitStatusResult["pr"] {
  return resolveThreadScopedGitStatus(input)?.pr ?? null;
}
