import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveChangeRequestSettlementState } from "@t3tools/client-runtime/state/thread-settled";

import { useEnvironmentQuery } from "./query";
import { presentThreadPr, type ThreadPrPresentation } from "./thread-pr-presentation";
import { vcsEnvironment } from "./vcs";

export {
  presentThreadPr,
  type ThreadPr,
  type ThreadPrPresentation,
} from "./thread-pr-presentation";

/**
 * Live PR status for a thread's branch. Subscriptions are deduplicated per
 * (environmentId, cwd) by the atom family, so many rows on the same worktree
 * or project root share one stream — and virtualization means only visible
 * rows subscribe at all.
 */
export function useThreadPrLookup(thread: EnvironmentThreadShell, projectCwd: string | null) {
  const cwd = thread.worktreePath ?? projectCwd;
  const gitStatus = useEnvironmentQuery(
    thread.branch !== null && cwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd },
        })
      : null,
  );

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
