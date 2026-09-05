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
  it("attaches on Enter and sends on Cmd/Ctrl+Enter", () => {
    expect(resolveAnnotationSubmission(keyboardEvent())).toBe("attach");
    expect(resolveAnnotationSubmission(keyboardEvent({ metaKey: true }))).toBe("send");
    expect(resolveAnnotationSubmission(keyboardEvent({ ctrlKey: true }))).toBe("send");
  });

  it("leaves Shift+Enter and composition events available for editing", () => {
    expect(resolveAnnotationSubmission(keyboardEvent({ shiftKey: true }))).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent({ isComposing: true }))).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent({ key: " " }))).toBeNull();
  });
});
