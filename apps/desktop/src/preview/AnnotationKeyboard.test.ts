import { describe, expect, it } from "vite-plus/test";

import { resolveAnnotationSubmission } from "./AnnotationKeyboard.ts";

const keyboardEvent = (
  overrides: Partial<Parameters<typeof resolveAnnotationSubmission>[0]> = {},
) => ({
  key: "Enter",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  isComposing: false,
  ...overrides,
});

describe("resolveAnnotationSubmission", () => {
  it("leaves Shift+Enter and composition events available for editing", () => {
    expect(resolveAnnotationSubmission(keyboardEvent({ shiftKey: true }), true)).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent({ isComposing: true }), true)).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent({ key: " " }), true)).toBeNull();
  });
});
