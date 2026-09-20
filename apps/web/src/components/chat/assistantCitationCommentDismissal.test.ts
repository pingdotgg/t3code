import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveAssistantCitationCommentDismissal } from "./assistantCitationCommentDismissal";

describe("resolveAssistantCitationCommentDismissal", () => {
  it("commits typed text when the popover is dismissed by clicking away", () => {
    expect(
      resolveAssistantCitationCommentDismissal({
        reason: "outside-press",
        draft: "needs a retry",
        savedComment: undefined,
      }),
    ).toEqual({ kind: "commit", comment: "needs a retry" });
  });

  it("commits an edited comment when focus leaves the popover", () => {
    expect(
      resolveAssistantCitationCommentDismissal({
        reason: "focus-out",
        draft: "second thought",
        savedComment: "first thought",
      }),
    ).toEqual({ kind: "commit", comment: "second thought" });
  });

  it("closes without saving when nothing changed", () => {
    expect(
      resolveAssistantCitationCommentDismissal({
        reason: "outside-press",
        draft: null,
        savedComment: "kept",
      }),
    ).toEqual({ kind: "close" });
    expect(
      resolveAssistantCitationCommentDismissal({
        reason: "outside-press",
        draft: "  kept ",
        savedComment: "kept",
      }),
    ).toEqual({ kind: "close" });
    expect(
      resolveAssistantCitationCommentDismissal({
        reason: "outside-press",
        draft: "kept",
        savedComment: " kept ",
      }),
    ).toEqual({ kind: "close" });
  });

  it("clears a comment when the draft was emptied", () => {
    expect(
      resolveAssistantCitationCommentDismissal({
        reason: "trigger-press",
        draft: "",
        savedComment: "old",
      }),
    ).toEqual({ kind: "commit", comment: "" });
  });

  it("keeps Escape as an explicit discard", () => {
    expect(
      resolveAssistantCitationCommentDismissal({
        reason: "escape-key",
        draft: "unsaved",
        savedComment: undefined,
      }),
    ).toEqual({ kind: "close" });
  });

  it("keeps the popover open instead of dropping an over-length draft", () => {
    expect(
      resolveAssistantCitationCommentDismissal({
        reason: "outside-press",
        draft: "x".repeat(ASSISTANT_CITATION_MAX_COMMENT_LENGTH + 1),
        savedComment: undefined,
      }),
    ).toEqual({ kind: "keep-open" });
  });
});
