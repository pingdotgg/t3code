import { describe, expect, it } from "vite-plus/test";

import {
  isNewTaskComposerFocusRequested,
  requestNewTaskComposerFocus,
  takeNewTaskDictationRequest,
} from "./new-task-composer-focus";

describe("new task composer focus", () => {
  it("starts dictation once, then focuses the keyboard when the draft reopens", () => {
    requestNewTaskComposerFocus("voice-request", "dictation");

    expect(isNewTaskComposerFocusRequested("voice-request")).toBe(false);
    expect(takeNewTaskDictationRequest("voice-request")).toBe(true);
    expect(takeNewTaskDictationRequest("voice-request")).toBe(false);
    expect(isNewTaskComposerFocusRequested("voice-request")).toBe(true);
  });

  it("never starts dictation for a keyboard request, another draft, or a draft without a request", () => {
    requestNewTaskComposerFocus("keyboard-request", "keyboard");
    expect(takeNewTaskDictationRequest("keyboard-request")).toBe(false);
    expect(isNewTaskComposerFocusRequested("keyboard-request")).toBe(true);

    requestNewTaskComposerFocus("voice-request", "dictation");
    expect(takeNewTaskDictationRequest("other-request")).toBe(false);
    expect(takeNewTaskDictationRequest(undefined)).toBe(false);
    expect(isNewTaskComposerFocusRequested(undefined)).toBe(false);
    expect(takeNewTaskDictationRequest("voice-request")).toBe(true);
  });
});
