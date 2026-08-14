import { describe, expect, it } from "vite-plus/test";

import {
  canSubmitNewTaskDraft,
  resolveNewTaskComposerSelection,
  shouldInterpretNewTaskSubmit,
} from "./new-task-submit";

describe("new-task submission eligibility", () => {
  const readyInput = {
    text: "Implement the task",
    incomingShareReady: true,
    importingShare: false,
    submitting: false,
    workspaceMode: "local" as const,
    selectedBranchName: null,
  };

  it("accepts a ready local draft", () => {
    expect(canSubmitNewTaskDraft(readyInput)).toBe(true);
  });

  it("blocks submission while incoming share work is incomplete", () => {
    expect(canSubmitNewTaskDraft({ ...readyInput, incomingShareReady: false })).toBe(false);
    expect(canSubmitNewTaskDraft({ ...readyInput, importingShare: true })).toBe(false);
  });

  it("blocks submission while React state is active", () => {
    expect(canSubmitNewTaskDraft({ ...readyInput, submitting: true })).toBe(false);
  });

  it("requires non-empty text and a non-empty worktree branch", () => {
    expect(canSubmitNewTaskDraft({ ...readyInput, text: " \n\t" })).toBe(false);
    expect(
      canSubmitNewTaskDraft({
        ...readyInput,
        workspaceMode: "worktree",
        selectedBranchName: null,
      }),
    ).toBe(false);
    expect(
      canSubmitNewTaskDraft({
        ...readyInput,
        workspaceMode: "worktree",
        selectedBranchName: "",
      }),
    ).toBe(false);
    expect(
      canSubmitNewTaskDraft({
        ...readyInput,
        workspaceMode: "worktree",
        selectedBranchName: "main",
      }),
    ).toBe(true);
  });

  it("interprets submit-time commands only when creating a new task", () => {
    expect(shouldInterpretNewTaskSubmit({ editingPendingTask: null })).toBe(true);
    expect(shouldInterpretNewTaskSubmit({ editingPendingTask: {} })).toBe(false);
  });

  it("resets selection to the hydrated draft end only when the draft key changes", () => {
    expect(
      resolveNewTaskComposerSelection({
        previousDraftKey: "new-task:project-1",
        draftKey: "pending-task:message-1",
        promptLength: 17,
        selection: { start: 2, end: 2 },
      }),
    ).toEqual({ start: 17, end: 17 });
    expect(
      resolveNewTaskComposerSelection({
        previousDraftKey: "pending-task:message-1",
        draftKey: "pending-task:message-1",
        promptLength: 4,
        selection: { start: 7, end: 7 },
      }),
    ).toEqual({ start: 4, end: 4 });
  });
});
