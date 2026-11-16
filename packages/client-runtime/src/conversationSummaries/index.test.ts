import type {
  ConversationSummarySourceRef,
  ConversationSummarySourceResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { conversationSummarySourceLabel } from "./index.ts";

const ref = {
  kind: "message",
  threadId: "thread",
  messageId: "message",
  digest: "a".repeat(64),
} as ConversationSummarySourceRef;

const source = (speaker?: {
  readonly label: string;
  readonly model: string;
}): ConversationSummarySourceResult =>
  ({
    state: "available",
    source: ref,
    text: "Keep the store decision open.",
    title: "Thread",
    role: "assistant",
    ...(speaker === undefined ? {} : { speaker }),
    createdAt: "2026-10-22T00:00:00.000Z",
    archived: false,
  }) as ConversationSummarySourceResult;

describe("conversation summary source labels", () => {
  it("names a peer instead of the thread agent", () => {
    expect(
      conversationSummarySourceLabel(ref, source({ label: "Astra", model: "gpt-6-astra" })),
    ).toBe("Astra (gpt-6-astra)");
  });

  it("keeps an unlabeled assistant as the assistant", () => {
    expect(conversationSummarySourceLabel(ref, source())).toBe("Assistant");
  });
});
