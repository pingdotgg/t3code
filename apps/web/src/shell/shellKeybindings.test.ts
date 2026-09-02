import { describe, expect, it } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  parseKeybindingShortcut,
} from "@t3tools/shared/keybindings";

import { buildShellKeybindings, toShellKeybinding } from "./shellKeybindings";

function shortcut(value: string) {
  const parsed = parseKeybindingShortcut(value);
  if (parsed === null) throw new Error(`unparseable shortcut ${value}`);
  return parsed;
}

describe("toShellKeybinding", () => {
  it("maps mod to Ctrl on Linux and replays it as ctrlKey", () => {
    expect(toShellKeybinding(shortcut("mod+shift+]"), "Linux x86_64")).toEqual({
      sequence: "Ctrl+Shift+]",
      key: "]",
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: false,
    });
  });

  it("maps mod to Command on macOS, which Qt spells Ctrl", () => {
    expect(toShellKeybinding(shortcut("mod+b"), "MacIntel")).toMatchObject({
      sequence: "Ctrl+B",
      metaKey: true,
      ctrlKey: false,
    });
    expect(toShellKeybinding(shortcut("ctrl+k"), "MacIntel")).toMatchObject({
      sequence: "Meta+K",
      metaKey: false,
      ctrlKey: true,
    });
  });

  it("names special keys the way QKeySequence expects", () => {
    expect(toShellKeybinding(shortcut("mod+arrowdown"), "Linux")?.sequence).toBe("Ctrl+Down");
    expect(toShellKeybinding(shortcut("alt+space"), "Linux")?.sequence).toBe("Alt+Space");
    expect(toShellKeybinding(shortcut("mod+f5"), "Linux")?.sequence).toBe("Ctrl+F5");
    expect(toShellKeybinding(shortcut("mod++"), "Linux")?.sequence).toBe("Ctrl++");
  });

  it("leaves unmodified and unnameable keys to the native control", () => {
    expect(toShellKeybinding(shortcut("escape"), "Linux")).toBeNull();
    expect(toShellKeybinding(shortcut("shift+enter"), "Linux")).toBeNull();
    expect(toShellKeybinding(shortcut("mod+mediaplay"), "Linux")).toBeNull();
  });
});

describe("buildShellKeybindings", () => {
  it("publishes each sequence once regardless of how many rules share it", () => {
    const config = compileResolvedKeybindingsConfig([
      { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
      { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
      { key: "mod+shift+m", command: "modelPicker.toggle" },
      { key: "escape", command: "commandPalette.toggle" },
    ]);
    expect(buildShellKeybindings(config, "Linux").map((binding) => binding.sequence)).toEqual([
      "Ctrl+D",
      "Ctrl+Shift+M",
    ]);
  });
});
