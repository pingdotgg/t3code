import { describe, expect, it } from "vite-plus/test";

import {
  appendChatSelectionAnnotationsToPrompt,
  formatChatSelectionAnnotation,
  parseChatSelectionMessageSegments,
  stripAppendedChatSelectionAnnotations,
  type ChatSelectionAnnotation,
} from "./chatSelectionAnnotation";

const annotation: ChatSelectionAnnotation = {
  id: "selection-1",
  selectedText: "Restart <the> adapter",
  comment: "Why is this necessary?",
};

describe("chat selection annotations", () => {
  it("round-trips selected text and comments without treating markup as tags", () => {
    const prompt = appendChatSelectionAnnotationsToPrompt("Explain this", [annotation]);
    const segments = parseChatSelectionMessageSegments(prompt);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      kind: "text",
      id: "chat-selection-text:0",
      text: "Explain this\n\n",
    });
    expect(segments[1]).toEqual({ kind: "selection", annotation });
  });

  it("supports multiple annotations", () => {
    const second = {
      ...annotation,
      id: "selection-2",
      comment: "Compare this",
    };
    const segments = parseChatSelectionMessageSegments(
      appendChatSelectionAnnotationsToPrompt("", [annotation, second]),
    );

    expect(segments.filter((segment) => segment.kind === "selection")).toHaveLength(2);
  });

  it("keeps user-authored chat selection markup as message text", () => {
    const userAuthoredMarkup = [
      '<chat_selection id="example">',
      "<selected_text>",
      "this is just an example",
      "</selected_text>",
      "<user_comment>",
      "please explain this format",
      "</user_comment>",
      "</chat_selection>",
    ].join("\n");

    expect(parseChatSelectionMessageSegments(userAuthoredMarkup)).toEqual([
      { kind: "text", id: "chat-selection-text:0", text: userAuthoredMarkup },
    ]);
  });

  it("does not let a user-authored opener swallow a following annotation", () => {
    const prompt = appendChatSelectionAnnotationsToPrompt("Explain this literal <chat_selection>", [
      annotation,
    ]);

    expect(parseChatSelectionMessageSegments(prompt)).toEqual([
      {
        kind: "text",
        id: "chat-selection-text:0",
        text: "Explain this literal <chat_selection>\n\n",
      },
      { kind: "selection", annotation },
    ]);
  });

  it("does not emit a block for an empty annotation list", () => {
    expect(appendChatSelectionAnnotationsToPrompt("Keep this", [])).toBe("Keep this");
    expect(formatChatSelectionAnnotation(annotation)).toContain("<selected_text>");
  });

  it("preserves prompt whitespace when appending annotations", () => {
    const prompt = "  Keep this  ";

    expect(appendChatSelectionAnnotationsToPrompt(prompt, [annotation])).toBe(
      `${prompt}\n\n${formatChatSelectionAnnotation(annotation)}`,
    );
  });

  it("strips app-appended annotations while preserving message text", () => {
    const prompt = appendChatSelectionAnnotationsToPrompt("Explain this", [annotation]);

    expect(stripAppendedChatSelectionAnnotations(prompt)).toBe("Explain this\n\n");
  });
});
