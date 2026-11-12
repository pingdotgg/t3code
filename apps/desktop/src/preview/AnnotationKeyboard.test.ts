import { describe, expect, it } from "vite-plus/test";

import { resolveAnnotationSubmission } from "./AnnotationKeyboard.ts";

const keyboardEvent = (
  overrides: Partial<Parameters<typeof resolveAnnotationSubmission>[0] & { keyCode: number }> = {},
) => ({
  key: "Enter",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  isComposing: false,
  keyCode: 13,
  ...overrides,
});

describe("resolveAnnotationSubmission", () => {
  it("leaves Shift+Enter and composition events available for editing", () => {
    expect(resolveAnnotationSubmission(keyboardEvent({ shiftKey: true }), true)).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent({ isComposing: true }), true)).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent({ keyCode: 229 }), true)).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent({ key: " " }), true)).toBeNull();
  });
});
