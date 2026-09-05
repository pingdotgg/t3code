import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { updateComposerDraftSettings } from "../../state/use-composer-drafts";

export function seedNewTaskDraftFromThread(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "branch" | "worktreePath">,
) {
  updateComposerDraftSettings(
    `new-task:${scopedProjectKey(thread.environmentId, thread.projectId)}`,
    {
      workspaceSelection: {
        // Reusing an existing checkout is the mobile flow's local mode. Worktree
        // mode creates a fresh worktree and deliberately ignores worktreePath.
        mode: "local",
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        startFromOrigin: false,
      },
    },
  );
}
