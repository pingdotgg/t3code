export type NewTaskSendAction = "send" | "pick-branch";

/**
 * Decides what tapping the New Thread send button should do. A worktree needs a
 * base branch, so when the composer cannot resolve one we open the branch picker
 * instead of sending. Local mode never needs a base branch, so it always sends.
 * The send button stays enabled either way; this only routes the tap.
 */
export function resolveNewTaskSendAction(input: {
  readonly workspaceMode: "local" | "worktree";
  readonly resolvedBranch: string | null;
}): NewTaskSendAction {
  return input.workspaceMode === "worktree" && input.resolvedBranch === null
    ? "pick-branch"
    : "send";
}
