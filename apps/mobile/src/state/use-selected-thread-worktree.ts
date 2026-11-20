import { isThreadCheckoutMissing } from "@t3tools/client-runtime/thread-checkout";

import { useEnvironmentQuery } from "./query";
import { useSelectedThreadWorktreePath } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { vcsEnvironment } from "./vcs";
import { resolvePreferredThreadWorktreePath } from "../features/terminal/terminalLaunchContext";

export function useSelectedThreadWorktree() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const detailWorktreePath = useSelectedThreadWorktreePath();

  const selectedThreadWorktreePath = resolvePreferredThreadWorktreePath({
    threadShellWorktreePath: selectedThread?.worktreePath ?? null,
    threadDetailWorktreePath: detailWorktreePath,
  });

  return {
    selectedThreadWorktreePath,
    selectedThreadCwd: selectedThreadWorktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
  };
}

/** The checkout git actions use: the project checkout once the thread's own was removed. */
export function useSelectedThreadGitCheckout() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const worktree = useSelectedThreadWorktree();
  const environmentId = selectedThread?.environmentId ?? null;
  const worktreePath = worktree.selectedThreadWorktreePath;
  const projectCwd = selectedThreadProject?.workspaceRoot ?? null;
  const worktreeStatus = useEnvironmentQuery(
    environmentId !== null && worktreePath !== null
      ? vcsEnvironment.status({ environmentId, input: { cwd: worktreePath } })
      : null,
  );
  const worktreeIsRepo = worktreeStatus.data?.isRepo;
  const projectStatus = useEnvironmentQuery(
    environmentId !== null && worktreeIsRepo === false && projectCwd !== null
      ? vcsEnvironment.status({ environmentId, input: { cwd: projectCwd } })
      : null,
  );
  const checkoutMissing = isThreadCheckoutMissing({
    worktreePath,
    worktreeIsRepo,
    projectIsRepo: projectStatus.data?.isRepo,
  });
  return checkoutMissing
    ? { selectedThreadWorktreePath: null, selectedThreadCwd: projectCwd, checkoutMissing }
    : { ...worktree, checkoutMissing };
}
