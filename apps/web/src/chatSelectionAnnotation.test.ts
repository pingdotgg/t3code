import { describe, expect, it } from "vite-plus/test";

import {
  appendChatSelectionAnnotationsToPrompt,
  collectChatSelectionAnnotationsByMessageId,
  countChatSelectionAnnotationsForMessage,
  deriveChatSelectionIndicators,
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

  it("does not treat the old public marker as an appended annotation", () => {
    const userAuthoredMarkup = [
      '<chat_selection id="example" data-t3code-appended="true">',
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

  it("recognizes sent annotations without a local registry", () => {
    const sentMarkup = [
      '<chat_selection id="not-generated" data-t3code-appended="t3code:not-generated">',
      "<selected_text>",
      "this was sent on another device",
      "</selected_text>",
      "<user_comment>",
      "keep the annotation",
      "</user_comment>",
      "</chat_selection>",
    ].join("\n");

    expect(parseChatSelectionMessageSegments(sentMarkup)).toEqual([
      {
        kind: "selection",
        annotation: {
          id: "not-generated",
          selectedText: "this was sent on another device",
          comment: "keep the annotation",
        },
      },
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

  it("uses global indicator numbers when annotations are grouped by message", () => {
    const second = { ...annotation, id: "selection-2", comment: "Second" };
    const numbers = new Map([
      [annotation.id, 1],
      [second.id, 3],
    ]);

    expect(
      deriveChatSelectionIndicators([annotation, second], numbers).map(({ number }) => number),
    ).toEqual([1, 3]);
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
