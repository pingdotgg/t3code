import { describe, expect, it } from "vite-plus/test";

import { codexMicroShortcutEvent } from "./codexMicroActions";

describe("codexMicroShortcutEvent", () => {
  it("replays the user's binding with the platform modifier", () => {
    const keybindings = [
      {
        command: "terminal.toggle" as const,
        shortcut: {
          key: "j",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
    ];
    expect(codexMicroShortcutEvent(keybindings, "terminal.toggle", "MacIntel")).toMatchObject({
      key: "j",
      metaKey: true,
      ctrlKey: false,
    });
    expect(codexMicroShortcutEvent(keybindings, "terminal.toggle", "Win32")).toMatchObject({
      metaKey: false,
      ctrlKey: true,
    });
    expect(codexMicroShortcutEvent(keybindings, "diff.toggle", "MacIntel")).toBeNull();
  });
});
