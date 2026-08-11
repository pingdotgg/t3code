import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { scopedProjectKey } from "../../lib/scopedEntities";
import {
  updateComposerDraftSettings,
  type ComposerDraftWorkspaceSelection,
} from "../../state/use-composer-drafts";

export function workspaceSelectionFromThread(
  thread: Pick<EnvironmentThreadShell, "branch" | "worktreePath">,
): ComposerDraftWorkspaceSelection {
  return {
    // Reusing an existing checkout is the mobile flow's local mode. Worktree
    // mode creates a fresh worktree and deliberately ignores worktreePath.
    mode: "local",
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    startFromOrigin: false,
  };
}

export function seedNewTaskDraftFromThread(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "branch" | "worktreePath">,
): void {
  updateComposerDraftSettings(
    `new-task:${scopedProjectKey(thread.environmentId, thread.projectId)}`,
    { workspaceSelection: workspaceSelectionFromThread(thread) },
  );
}
