import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_KEYBINDINGS } from "./keybindings.ts";

describe("workspace pane keybindings", () => {
  it("ships Vim-direction split and focus shortcuts plus focus view", () => {
    const keyByCommand = new Map(
      DEFAULT_KEYBINDINGS.map((binding) => [binding.command, binding.key] as const),
    );

    expect(keyByCommand.get("pane.splitLeft")).toBe("mod+shift+h");
    expect(keyByCommand.get("pane.splitDown")).toBe("mod+shift+j");
    expect(keyByCommand.get("pane.splitUp")).toBe("mod+shift+k");
    expect(keyByCommand.get("pane.splitRight")).toBe("mod+shift+l");
    expect(keyByCommand.get("pane.focusLeft")).toBe("mod+alt+h");
    expect(keyByCommand.get("pane.focusDown")).toBe("mod+alt+j");
    expect(keyByCommand.get("pane.focusUp")).toBe("mod+alt+k");
    expect(keyByCommand.get("pane.focusRight")).toBe("mod+alt+l");
    expect(keyByCommand.get("pane.toggleMaximized")).toBe("mod+shift+enter");
  });

  it("keeps every default shortcut unambiguous within the same context", () => {
    const keys = DEFAULT_KEYBINDINGS.map((binding) => `${binding.key}\u0000${binding.when ?? ""}`);

    expect(new Set(keys).size).toBe(keys.length);
  });
});
