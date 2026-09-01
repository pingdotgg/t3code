export type NewTaskSendAction = "send" | "pick-branch";

/**
 * Decides what tapping the New Thread send button should do. A worktree needs a
 * base branch, so when the composer cannot resolve one we open the branch picker
 * instead of sending. Local mode never needs a base branch, so it always sends.
 *
 * A worktree tap also routes to the picker while the workspace mode is still
 * unsettled (t3.json loading, no explicit pick or project setting): the resolved
 * mode is provisional then, so auto-sending — or writing that mode into the
 * draft — could commit a worktree the project file later resolves away from.
 * Letting the user pick a branch settles the choice explicitly instead.
 *
 * The send button stays enabled either way; this only routes the tap.
 */
export function resolveNewTaskSendAction(input: {
  readonly workspaceMode: "local" | "worktree";
  readonly resolvedBranch: string | null;
  readonly workspaceModeSettled: boolean;
}): NewTaskSendAction {
  if (input.workspaceMode !== "worktree") {
    return "send";
  }
  return input.resolvedBranch === null || !input.workspaceModeSettled ? "pick-branch" : "send";
}
