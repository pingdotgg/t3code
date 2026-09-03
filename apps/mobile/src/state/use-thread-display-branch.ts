import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { useEnvironmentQuery } from "./query";
import { resolveThreadDisplayBranch } from "./thread-display-branch";
import { vcsEnvironment } from "./vcs";

/**
 * Branch label for a thread list row. Stored `thread.branch` needs no fetch;
 * the live status stream is only subscribed for local null-branch threads,
 * where it is the same deduplicated per-(environmentId, cwd) stream the PR
 * badge and the new-task composer already share — so rows on one project
 * root share one subscription, and virtualization keeps it to visible rows.
 */
export function useThreadDisplayBranch(
  thread: EnvironmentThreadShell,
  projectCwd: string | null,
): string | null {
  const cwd = thread.worktreePath ?? projectCwd;
  const needsLiveBranch = thread.branch === null && thread.worktreePath === null && cwd !== null;
  const liveStatus = useEnvironmentQuery(
    needsLiveBranch
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd },
        })
      : null,
  );
  return resolveThreadDisplayBranch({
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    liveCheckoutBranch: liveStatus.data?.refName ?? null,
  });
}
