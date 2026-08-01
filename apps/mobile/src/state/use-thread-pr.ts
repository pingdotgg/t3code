import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveChangeRequestSettlementState } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentQuery } from "./query";
import { presentThreadPr, type ThreadPrPresentation } from "./thread-pr-presentation";
import { vcsEnvironment } from "./vcs";

export {
  presentThreadPr,
  type ThreadPr,
  type ThreadPrPresentation,
} from "./thread-pr-presentation";

export function useThreadVcsStatus(environmentId: EnvironmentId, cwd: string | null) {
  return useEnvironmentQuery(
    cwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd },
        }),
  );
}

/**
 * Live PR status for a thread's branch. Subscriptions are deduplicated per
 * (environmentId, cwd) by the atom family, so visible rows and Thread List
 * v2's bounded off-screen lookup pool share one stream per worktree/project.
 */
export function useThreadPrLookup(thread: EnvironmentThreadShell, projectCwd: string | null) {
  const cwd = thread.worktreePath ?? projectCwd;
  const gitStatus = useThreadVcsStatus(thread.environmentId, thread.branch === null ? null : cwd);

  const status = gitStatus.data;
  const changeRequestState = resolveChangeRequestSettlementState({
    threadBranch: thread.branch,
    gitStatus: status,
    gitStatusError: gitStatus.error,
  });
  const pr =
    status !== null && thread.branch !== null && status.refName === thread.branch && status.pr
      ? presentThreadPr(status.pr, status.sourceControlProvider)
      : null;
  return { changeRequestState, pr };
}

export function useThreadPr(
  thread: EnvironmentThreadShell,
  projectCwd: string | null,
): ThreadPrPresentation | null {
  return useThreadPrLookup(thread, projectCwd).pr;
}
