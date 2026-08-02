import { describe, expect, it } from "vite-plus/test";

import {
  appendChatSelectionAnnotationsToPrompt,
  collectChatSelectionAnnotationsByMessageId,
  countChatSelectionAnnotationsForMessage,
  deriveChatSelectionIndicators,
  formatChatSelectionAnnotation,
  parseChatSelectionMessageSegments,
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

    expect(countChatSelectionAnnotationsForMessage([annotation, second], "selection-message")).toBe(
      0,
    );
    expect(
      countChatSelectionAnnotationsForMessage(
        [{ ...annotation, messageId: "selection-message" }, second],
        "selection-message",
      ),
    ).toBe(1);
  });

  it("does not emit a block for an empty annotation list", () => {
    expect(appendChatSelectionAnnotationsToPrompt("Keep this", [])).toBe("Keep this");
    expect(formatChatSelectionAnnotation(annotation)).toContain("<selected_text>");
  });

  it("persists the source message id in the sent prompt", () => {
    const sourceAnnotation = {
      ...annotation,
      messageId: "assistant-1",
      sourceStart: 42,
      sourceEnd: 63,
    };
    const prompt = appendChatSelectionAnnotationsToPrompt("Explain this", [sourceAnnotation]);
    const segments = parseChatSelectionMessageSegments(prompt);

    expect(segments[1]).toEqual({ kind: "selection", annotation: sourceAnnotation });
    expect(prompt).toContain('message_id="assistant-1"');
    expect(prompt).toContain('source_start="42" source_end="63"');
  });

  it("groups pending annotations by source message", () => {
    const pending = { ...annotation, messageId: "assistant-1" };
    const byMessageId = collectChatSelectionAnnotationsByMessageId([pending]);

    expect(byMessageId.get("assistant-1")).toEqual([pending]);
    expect(deriveChatSelectionIndicators([pending])).toEqual([
      {
        id: pending.id,
        kind: "text-comment",
        number: 1,
        annotation: pending,
      },
    ]);
  });

  it("creates one numbered indicator for every annotation in source order", () => {
    const second = { ...annotation, id: "selection-2", comment: "" };

    expect(deriveChatSelectionIndicators([annotation, second])).toEqual([
      {
        id: annotation.id,
        kind: "text-comment",
        number: 1,
        annotation,
      },
      {
        id: second.id,
        kind: "text-selection",
        number: 2,
        annotation: second,
      },
    ]);
  });
});
