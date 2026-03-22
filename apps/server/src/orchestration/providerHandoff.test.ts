import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildProviderHandoffPrompt, getMessagesBeforeMessage } from "./providerHandoff.ts";

const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);

describe("providerHandoff", () => {
  it("caps a single oversized transcript message", () => {
    const prompt = buildProviderHandoffPrompt({
      messagesBeforeCurrent: [
        {
          id: asMessageId("msg-1"),
          role: "assistant",
          text: "A".repeat(20_000),
        },
      ],
      previousProvider: "codex",
      nextProvider: "claudeAgent",
      previousModel: "gpt-5.4",
      nextModel: "claude-sonnet-4-6",
      latestUserText: "continue",
    });

    expect(prompt).toBeDefined();
    expect(prompt).toContain("[Message truncated for length]");
    expect(prompt?.length).toBeLessThanOrEqual(12_500);
  });

  it("returns messages before the current message only", () => {
    const messages = [
      { id: asMessageId("msg-1") },
      { id: asMessageId("msg-2") },
      { id: asMessageId("msg-3") },
    ];

    expect(getMessagesBeforeMessage(messages, asMessageId("msg-2"))).toEqual([messages[0]]);
    expect(getMessagesBeforeMessage(messages, asMessageId("msg-1"))).toEqual([]);
  });
});
