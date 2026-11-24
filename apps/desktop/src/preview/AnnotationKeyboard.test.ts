import { describe, expect, it } from "vite-plus/test";

import { resolveAnnotationSubmission } from "./AnnotationKeyboard.ts";

const keyboardEvent = (
  overrides: Partial<Parameters<typeof resolveAnnotationSubmission>[0]> = {},
) => ({
  isTrusted: true,
  key: "Enter",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  isComposing: false,
  ...overrides,
});

describe("resolveAnnotationSubmission", () => {
  it("requires trusted input to attach or send an annotation", () => {
    expect(resolveAnnotationSubmission(keyboardEvent(), true)).toBe("attach");
    expect(resolveAnnotationSubmission(keyboardEvent({ metaKey: true }), true)).toBe("send");
    expect(resolveAnnotationSubmission(keyboardEvent({ isTrusted: false }), true)).toBeNull();
    expect(
      resolveAnnotationSubmission(keyboardEvent({ isTrusted: false, metaKey: true }), true),
    ).toBeNull();
  });
  it("leaves Shift+Enter and composition events available for editing", () => {
    expect(resolveAnnotationSubmission(keyboardEvent({ shiftKey: true }), true)).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent({ isComposing: true }), true)).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent({ key: " " }), true)).toBeNull();
  });
});
