import { describe, expect, it } from "vitest";
import { ThreadId } from "@t3tools/contracts";

import {
  appendDiffContextCommentsToPrompt,
  extractTrailingDiffContextComments,
  type DiffContextCommentDraft,
} from "./diffContextComments";

function makeComment(input: {
  id: string;
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  side?: "additions" | "deletions";
  body: string;
}): DiffContextCommentDraft {
  return {
    id: input.id,
    threadId: ThreadId.makeUnsafe("thread-diff-comments"),
    turnId: null,
    filePath: input.filePath,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd ?? input.lineStart,
    side: input.side ?? "additions",
    body: input.body,
    createdAt: "2026-03-12T00:00:00.000Z",
  };
}

describe("diffContextComments", () => {
  it("preserves multiline comment bodies in the serialized prompt block", () => {
    const prompt = appendDiffContextCommentsToPrompt("Please address these.", [
      makeComment({
        id: "comment-1",
        filePath: "src/example.ts",
        lineStart: 12,
        body: "Keep the guard.\n- This branch is still reachable.\n\nAdd a test.",
      }),
    ]);

    expect(prompt).toContain("- src/example.ts:+12:");
    expect(prompt).toContain("  Keep the guard.");
    expect(prompt).toContain("  - This branch is still reachable.");
    expect(prompt).toContain("  ");
    expect(prompt).toContain("  Add a test.");
  });

  it("extracts previews from both multiline and legacy single-line comment blocks", () => {
    const multilinePrompt = appendDiffContextCommentsToPrompt("Prompt text", [
      makeComment({
        id: "comment-1",
        filePath: "src/example.ts",
        lineStart: 12,
        lineEnd: 14,
        body: "First line\nSecond line",
      }),
      makeComment({
        id: "comment-2",
        filePath: "src/old.ts",
        lineStart: 5,
        side: "deletions",
        body: "Legacy formatting should still parse.",
      }),
    ]);

    expect(extractTrailingDiffContextComments(multilinePrompt)).toEqual({
      promptText: "Prompt text",
      commentCount: 2,
      previewTitle:
        "src/example.ts:+12-14\nFirst line\nSecond line\n\nsrc/old.ts:-5\nLegacy formatting should still parse.",
    });

    const legacyPrompt = [
      "Prompt text",
      "",
      "<diff_context_comments>",
      "- src/example.ts:+12: One line only",
      "</diff_context_comments>",
    ].join("\n");

    expect(extractTrailingDiffContextComments(legacyPrompt)).toEqual({
      promptText: "Prompt text",
      commentCount: 1,
      previewTitle: "src/example.ts:+12\nOne line only",
    });
  });
});
