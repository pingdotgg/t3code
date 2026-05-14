import { describe, expect, it, vi } from "vite-plus/test";

import { shouldIgnoreChatGlobalShortcutEvent } from "./chatGlobalShortcuts";

describe("chat global shortcuts", () => {
  it("does not dispatch archive for repeated keydown events", () => {
    const archiveCurrentThread = vi.fn();
    const event = {
      defaultPrevented: false,
      repeat: true,
    } satisfies Pick<KeyboardEvent, "defaultPrevented" | "repeat">;

    if (!shouldIgnoreChatGlobalShortcutEvent(event)) {
      archiveCurrentThread();
    }

    expect(archiveCurrentThread).not.toHaveBeenCalled();
  });
});
