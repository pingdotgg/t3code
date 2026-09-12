import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_KEYBINDINGS } from "./keybindings.ts";

describe("workspace pane keybindings", () => {
  it("ships Vim-direction split and focus shortcuts plus focus view", () => {
    const bindingByCommand = new Map(
      DEFAULT_KEYBINDINGS.map((binding) => [binding.command, binding] as const),
    );

    expect(bindingByCommand.get("pane.splitLeft")?.key).toBe("mod+shift+h");
    expect(bindingByCommand.get("pane.splitDown")?.key).toBe("mod+shift+j");
    expect(bindingByCommand.get("pane.splitUp")?.key).toBe("mod+shift+k");
    expect(bindingByCommand.get("pane.splitRight")?.key).toBe("mod+shift+l");
    expect(bindingByCommand.get("pane.focusLeft")).toEqual({
      key: "mod+alt+h",
      command: "pane.focusLeft",
    });
    expect(bindingByCommand.get("pane.focusDown")).toEqual({
      key: "mod+alt+j",
      command: "pane.focusDown",
    });
    expect(bindingByCommand.get("pane.focusUp")).toEqual({
      key: "mod+alt+k",
      command: "pane.focusUp",
    });
    expect(bindingByCommand.get("pane.focusRight")).toEqual({
      key: "mod+alt+l",
      command: "pane.focusRight",
    });
    expect(bindingByCommand.get("pane.toggleMaximized")?.key).toBe("mod+shift+enter");
  });

  it("keeps every default shortcut unambiguous within the same context", () => {
    const keys = DEFAULT_KEYBINDINGS.map((binding) => `${binding.key}\u0000${binding.when ?? ""}`);

    expect(new Set(keys).size).toBe(keys.length);
  });
});
