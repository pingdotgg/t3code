import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { resolveSelectedRepoWorktree } from "@t3tools/client-runtime/state/threads";
import type { ThreadRepoWorktree } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useEnvironmentQuery } from "./query";
import { environmentThreadDetails } from "./threads";
import { useSelectedThreadWorktreePath } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { vcsEnvironment } from "./vcs";
import { resolvePreferredThreadWorktreePath } from "../features/terminal/terminalLaunchContext";

const NO_REPO_WORKTREES = Atom.make<ReadonlyArray<ThreadRepoWorktree>>([]);
const NO_SELECTION = Atom.make<string | null | undefined>(undefined);

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

/**
 * Where the selected thread's Git actions and Changes work: a repository
 * worktree the user chose, or the thread's own workspace. Files and terminals
 * keep using the workspace.
 */
export function useSelectedThreadSourceControl() {
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const threadRef =
    selectedThread === null
      ? null
      : { environmentId: selectedThread.environmentId, threadId: selectedThread.id };
  const repoWorktrees = useAtomValue(
    threadRef === null ? NO_REPO_WORKTREES : environmentThreadDetails.repoWorktreesAtom(threadRef),
  );
  const selectionAtom =
    threadRef === null
      ? NO_SELECTION
      : environmentThreadDetails.repoWorktreeSelectionAtom(threadRef);
  const selection = useAtomValue(selectionAtom);
  const setSelection = useAtomSet(selectionAtom);
  const workspaceStatus = useEnvironmentQuery(
    threadRef !== null && selectedThreadCwd !== null && repoWorktrees.length > 0
      ? vcsEnvironment.status({
          environmentId: threadRef.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  const repoWorktree = resolveSelectedRepoWorktree({
    repoWorktrees,
    selection,
    workspaceIsRepository: workspaceStatus.data?.isRepo ?? true,
  });
  const select = (worktreePath: string | null) => setSelection(worktreePath);
  return {
    repoWorktrees,
    repoWorktree,
    select,
    sourceControlCwd: repoWorktree?.worktreePath ?? selectedThreadCwd,
  };
}
