import { MessageId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { sendThreadComposerMessage } from "./thread-composer-send";

describe("thread composer send", () => {
  it("does not run sent side effects when the draft was not queued", async () => {
    const onSent = vi.fn();

    await expect(
      sendThreadComposerMessage({
        onSendMessage: async () => null,
        onSent,
      }),
    ).resolves.toBeNull();
    expect(onSent).not.toHaveBeenCalled();
  });

  it("runs sent side effects after a draft is queued", async () => {
    const messageId = MessageId.make("message-1");
    const onSent = vi.fn();

    await expect(
      sendThreadComposerMessage({
        onSendMessage: async () => messageId,
        onSent,
      }),
    ).resolves.toBe(messageId);
    expect(onSent).toHaveBeenCalledOnce();
  });
});
