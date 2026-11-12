import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AuthSourceControlWriteScope } from "@t3tools/contracts";

import {
  type ReleasedCheckoutWorktree,
  releasedCheckoutWorktrees,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readProject, readThreadShell, readThreadShells } from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { vcsEnvironment } from "../../state/vcs";

function removeReleasedWorktree(released: ReleasedCheckoutWorktree): void {
  const { environmentId, worktreePath } = released;
  if (readThreadShell(scopeThreadRef(environmentId, released.threadId))) return;
  const usedByThread = readThreadShells().some(
    (thread) => thread.environmentId === environmentId && thread.worktreePath === worktreePath,
  );
  if (usedByThread || !readEnvironmentScope(environmentId, AuthSourceControlWriteScope)) return;
  const project = readProject(scopeProjectRef(environmentId, released.projectId));
  if (!project) return;
  // Without force, Git keeps a worktree that holds edits; storage cleanup still lists it.
  void runAtomCommand(
    appAtomRegistry,
    vcsEnvironment.removeWorktree,
    {
      environmentId,
      input: {
        cwd: project.workspaceRoot,
        path: worktreePath,
        // Drafts on other clients are invisible here; the server knows whether one reused it.
        onlyUnsharedPullRequestCheckout: true,
      },
    },
    { reportFailure: false, reportDefect: false },
  );
}

/** Removes a worktree a pull request checkout created once its draft drops it unsent. */
export function startCheckoutWorktreeRelease(): () => void {
  return useComposerDraftStore.subscribe((state, previous) => {
    for (const released of releasedCheckoutWorktrees(
      previous.draftThreadsByThreadKey,
      state.draftThreadsByThreadKey,
    )) {
      removeReleasedWorktree(released);
    }
  });
}
