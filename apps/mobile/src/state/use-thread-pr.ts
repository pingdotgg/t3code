import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

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
 *
 * Keyed by the thread's recorded branch, not the current checkout: the
 * streamed status is the fast path while the checkout matches, and a
 * branch-keyed lookup keeps the badge alive once the checkout moves away.
 */
export function useThreadPr(
  thread: EnvironmentThreadShell,
  projectCwd: string | null,
): ThreadPrPresentation | null {
  const cwd = thread.worktreePath ?? projectCwd;
  const gitStatus = useEnvironmentQuery(
    thread.branch !== null && cwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd },
        })
      : null,
  );
  const branchPr = useEnvironmentQuery(
    thread.branch !== null && cwd !== null
      ? vcsEnvironment.branchPr({
          environmentId: thread.environmentId,
          input: { cwd, branch: thread.branch },
        })
      : null,
  );

  const status = gitStatus.data;
  // When the status describes the thread's own branch it is authoritative
  // about that branch's PR — including when it reports none, so this must not
  // fall through to a warm branch lookup that would resurrect a stale badge.
  if (status !== null && thread.branch !== null && status.refName === thread.branch) {
    return status.pr ? presentThreadPr(status.pr, status.sourceControlProvider) : null;
  }
  const pr = branchPr.data?.pr;
  if (!pr) {
    return null;
  }
  return presentThreadPr(pr, status?.sourceControlProvider);
}
