import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_KEYBINDINGS,
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingsConfig,
} from "./keybindings.ts";

describe("voice keybindings", () => {
  it("compiles a custom voice toggle without shipping a default shortcut", () => {
    const resolved = compileResolvedKeybindingsConfig([
      { key: "mod+alt+v", command: "voice.toggle" },
    ]);

    expect(resolved).toEqual([
      {
        command: "voice.toggle",
        shortcut: {
          key: "v",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: true,
          modKey: true,
        },
      },
    ]);
    expect(DEFAULT_KEYBINDINGS.some((binding) => binding.command === "voice.toggle")).toBe(false);
    expect(DEFAULT_RESOLVED_KEYBINDINGS.some((binding) => binding.command === "voice.toggle")).toBe(
      false,
    );
  });
});
