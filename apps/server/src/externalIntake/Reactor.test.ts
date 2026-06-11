import { describe, expect, it } from "vite-plus/test";

import {
  assistantAttachmentDeliveryKey,
  assistantTextDeliveryKey,
  shouldFinalizeAssistantRelayFromMessage,
} from "./Reactor.ts";

describe("ExternalIntakeReactor", () => {
  it("uses a separate delivery key for assistant attachments", () => {
    const base = {
      phase: "final" as const,
      threadId: "thread-csv",
      turnId: "turn-csv",
      messageId: "assistant-final",
      externalThreadId: "T123:C123:1781138017.962159",
    };

    expect(assistantAttachmentDeliveryKey({ ...base, attachmentId: "attachment-1" })).toBe(
      "assistant-attachment:final:thread-csv:turn-csv:attachment-1:T123:C123:1781138017.962159",
    );
    expect(assistantAttachmentDeliveryKey({ ...base, attachmentId: "attachment-1" })).not.toBe(
      assistantTextDeliveryKey(base),
    );
  });

  it("finalizes attachment-only assistant updates that still have a turn id", () => {
    expect(
      shouldFinalizeAssistantRelayFromMessage({
        streaming: false,
        turnId: "turn-csv",
        attachments: [
          {
            type: "file",
            id: "attachment-1",
            name: "restaurants.csv",
            mimeType: "text/csv",
            sizeBytes: 12,
          },
        ],
      }),
    ).toBe(true);

    expect(
      shouldFinalizeAssistantRelayFromMessage({
        streaming: false,
        turnId: "turn-csv",
      }),
    ).toBe(false);
  });
});
