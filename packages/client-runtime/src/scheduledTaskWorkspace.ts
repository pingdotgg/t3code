import type { ScheduledTaskUpsertInput } from "@t3tools/contracts";

/** A Settings form's workspace fields; a blank `baseRef` means the project's default branch. */
export interface ScheduledTaskWorkspaceDraft {
  readonly mode: "worktree" | "root" | "existing_worktree";
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly worktreePath: string;
}

export function scheduledTaskWorkspaceInput(
  draft: ScheduledTaskWorkspaceDraft,
): Pick<ScheduledTaskUpsertInput, "workspaceStrategy" | "defaultBaseRef"> {
  if (draft.mode === "root") return { workspaceStrategy: { type: "root" } };
  if (draft.mode === "existing_worktree")
    return {
      workspaceStrategy: { type: "existing_worktree", worktreePath: draft.worktreePath.trim() },
    };
  const baseRef = draft.baseRef.trim();
  return baseRef === ""
    ? {
        // Older servers ignore `defaultBaseRef` and keep `main`, as they always have.
        workspaceStrategy: {
          type: "worktree",
          baseRef: "main",
          startFromOrigin: draft.startFromOrigin,
        },
        defaultBaseRef: true,
      }
    : {
        workspaceStrategy: { type: "worktree", baseRef, startFromOrigin: draft.startFromOrigin },
      };
}
