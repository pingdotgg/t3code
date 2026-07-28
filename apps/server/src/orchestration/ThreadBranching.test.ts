import { MessageId, type OrchestrationMessage } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  formatThreadBranchPrompt,
  selectThreadBranchContext,
  THREAD_BRANCH_MAX_CONTEXT_CHARS,
  THREAD_BRANCH_MAX_MESSAGES,
} from "./ThreadBranching.ts";

const message = (index: number, text = `message ${index}`): OrchestrationMessage => ({
  id: MessageId.make(`message-${index}`),
  role: index % 2 === 0 ? "user" : "assistant",
  text,
  turnId: null,
  streaming: false,
  createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
  updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
});

describe("thread branching context", () => {
  it("keeps the newest bounded messages in chronological order", () => {
    const messages = Array.from({ length: THREAD_BRANCH_MAX_MESSAGES + 4 }, (_, index) =>
      message(index),
    );

    const selected = selectThreadBranchContext(messages);

    expect(selected.messages).toHaveLength(THREAD_BRANCH_MAX_MESSAGES);
    expect(selected.messages[0]?.text).toBe("message 4");
    expect(selected.messages.at(-1)?.text).toBe(`message ${THREAD_BRANCH_MAX_MESSAGES + 3}`);
    expect(selected.omittedMessageCount).toBe(4);
  });

  it("retains the tail of an oversized newest message", () => {
    const selected = selectThreadBranchContext([
      message(0, "old"),
      message(1, `prefix-${"x".repeat(THREAD_BRANCH_MAX_CONTEXT_CHARS)}-tail`),
    ]);

    expect(selected.messages).toHaveLength(1);
    expect(selected.messages[0]?.text).toContain("[Earlier content omitted]");
    expect(selected.messages[0]?.text.endsWith("-tail")).toBe(true);
    expect(selected.omittedMessageCount).toBe(1);
  });

  it("does not exceed the character budget when only marker space remains", () => {
    const selected = selectThreadBranchContext([
      message(0, "older context"),
      message(1, "x".repeat(THREAD_BRANCH_MAX_CONTEXT_CHARS - 10)),
    ]);

    expect(selected.messages).toHaveLength(1);
    expect(selected.messages[0]?.id).toBe(MessageId.make("message-1"));
    expect(
      selected.messages.reduce((total, entry) => total + entry.text.length, 0),
    ).toBeLessThanOrEqual(THREAD_BRANCH_MAX_CONTEXT_CHARS);
    expect(selected.omittedMessageCount).toBe(1);
  });

  it("labels inherited context separately from the new user message", () => {
    const prompt = formatThreadBranchPrompt({
      sourceTitle: "Original",
      messages: [message(0, "first question"), message(1, "first answer")],
      currentMessage: "try another approach",
    });

    expect(prompt).toContain('branched from "Original"');
    expect(prompt).toContain("<branched_conversation>");
    expect(prompt).toContain("Assistant:\nfirst answer");
    expect(prompt).toContain("<current_user_message>\n\ntry another approach");
  });
});
