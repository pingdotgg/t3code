import { describe, expect, it } from "vite-plus/test";
import type { ServerConfigStreamEvent } from "@t3tools/contracts";

import { createKeybindingsUpdateToastController } from "./KeybindingsUpdateToast.logic";

function keybindingsUpdated(issueMessages: ReadonlyArray<string>): ServerConfigStreamEvent {
  return {
    version: 1,
    type: "keybindingsUpdated",
    payload: {
      keybindings: [],
      issues: issueMessages.map((message, index) => ({
        kind: "keybindings.invalid-entry" as const,
        message,
        index,
      })),
    },
  };
}

describe("keybindings update toast", () => {
  it("shows one warning when a save and the file watcher report the same issue", () => {
    let currentTime = 0;
    const controller = createKeybindingsUpdateToastController({ now: () => currentTime });
    const invalid = { _tag: "InvalidConfiguration", message: "unknown command" };

    expect(controller.handle(keybindingsUpdated(["unknown command"]))).toEqual(invalid);
    currentTime = 100;
    expect(controller.handle(keybindingsUpdated(["unknown command"]))).toBeNull();

    currentTime = 200;
    expect(controller.handle(keybindingsUpdated(["bad shortcut"]))).toEqual({
      _tag: "InvalidConfiguration",
      message: "bad shortcut",
    });

    currentTime = 5_000;
    expect(controller.handle(keybindingsUpdated(["bad shortcut"]))).toEqual({
      _tag: "InvalidConfiguration",
      message: "bad shortcut",
    });
    currentTime = 5_100;
    expect(controller.handle(keybindingsUpdated([]))).toEqual({ _tag: "Success" });
    currentTime = 5_200;
    expect(controller.handle(keybindingsUpdated([]))).toBeNull();
  });
});
