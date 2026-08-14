export function shouldInterpretNewTaskSubmit(input: {
  readonly editingPendingTask: object | null;
}): boolean {
  return input.editingPendingTask === null;
}

export function resolveNewTaskComposerSelection(input: {
  readonly previousDraftKey: string | null;
  readonly draftKey: string | null;
  readonly promptLength: number;
  readonly selection: { readonly start: number; readonly end: number };
}): { readonly start: number; readonly end: number } {
  if (input.previousDraftKey !== input.draftKey) {
    return { start: input.promptLength, end: input.promptLength };
  }
  return {
    start: Math.max(0, Math.min(input.selection.start, input.promptLength)),
    end: Math.max(0, Math.min(input.selection.end, input.promptLength)),
  };
}

export function canSubmitNewTaskDraft(input: {
  readonly text: string;
  readonly incomingShareReady: boolean;
  readonly importingShare: boolean;
  readonly submitting: boolean;
  readonly workspaceMode: "local" | "worktree";
  readonly selectedBranchName: string | null;
}): boolean {
  return (
    input.text.trim().length > 0 &&
    input.incomingShareReady &&
    !input.importingShare &&
    !input.submitting &&
    (input.workspaceMode !== "worktree" || Boolean(input.selectedBranchName))
  );
}
