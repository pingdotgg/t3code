import type { DefaultBranchConfirmableAction } from "@t3tools/client-runtime/state/vcs";
import type { VcsStatusAccumulatedResult } from "@t3tools/contracts";

export function parseDefaultBranchConfirmableAction(
  value: string | undefined,
): DefaultBranchConfirmableAction | null {
  switch (value) {
    case "push":
    case "create_pr":
    case "commit_push":
    case "commit_push_pr":
      return value;
    default:
      return null;
  }
}

export function canRunConfirmedGitAction(input: {
  readonly confirmAction: DefaultBranchConfirmableAction | null;
  readonly expectedBranch: string;
  readonly expectedCwd: string;
  readonly currentCwd: string | null;
  readonly status: VcsStatusAccumulatedResult | null;
}): boolean {
  return (
    input.confirmAction !== null &&
    input.expectedBranch.length > 0 &&
    input.expectedCwd.trim().length > 0 &&
    input.currentCwd?.trim() === input.expectedCwd.trim() &&
    input.status?.isRepo === true &&
    input.status.remoteStatusKnown &&
    input.status.refName === input.expectedBranch
  );
}

export async function runAfterSuccessfulBranchCreation(input: {
  readonly createBranch: () => Promise<boolean>;
  readonly runAction: () => Promise<unknown>;
}): Promise<boolean> {
  const created = await input.createBranch();
  if (!created) {
    return false;
  }
  await input.runAction();
  return true;
}
