export type NewTaskComposerFocus = "keyboard" | "dictation";

// Kept out of route params so a restored draft URL never reopens the keyboard; request ids are unique per new task.
let focusRequest: { readonly requestId: string; readonly focus: NewTaskComposerFocus } | null =
  null;

export function requestNewTaskComposerFocus(requestId: string, focus: NewTaskComposerFocus): void {
  focusRequest = { requestId, focus };
}

function requestedFocus(requestId: string | undefined): NewTaskComposerFocus | null {
  return requestId !== undefined && focusRequest?.requestId === requestId
    ? focusRequest.focus
    : null;
}

export function isNewTaskComposerFocusRequested(requestId: string | undefined): boolean {
  return requestedFocus(requestId) === "keyboard";
}

/** Dictation starts once; reopening the same draft focuses the keyboard instead of the microphone. */
export function takeNewTaskDictationRequest(requestId: string | undefined): boolean {
  if (requestId === undefined || requestedFocus(requestId) !== "dictation") return false;
  focusRequest = { requestId, focus: "keyboard" };
  return true;
}
