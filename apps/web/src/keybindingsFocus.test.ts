import { describe, expect, it, vi } from "vite-plus/test";
import type { KeybindingCommand } from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { resolveShortcutCommand } from "./keybindings";
import * as editableFocus from "./lib/editableFocus";

function setupFocus() {
  const editor = new EventTarget();
  const other = new EventTarget();
  vi.stubGlobal("document", { activeElement: editor });
  const focus = vi
    .spyOn(editableFocus, "isEditableFocused")
    .mockImplementation((target) => target === editor);
  return {
    editor,
    other,
    [Symbol.dispose]() {
      focus.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

function keydown(target?: EventTarget) {
  return {
    key: "k",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...(target ? { target } : {}),
  };
}

function bindings(command: KeybindingCommand, when = "!editableFocus") {
  return compileResolvedKeybindingsConfig([{ key: "mod+k", command, when }]);
}

describe("editable shortcut conditions", () => {
  it.each(["commandPalette.toggle", "sidebar.toggle", "thread.next", "thread.jump.1"] as const)(
    "honors !editableFocus for %s without a caller-provided focus context",
    (command) => {
      using focus = setupFocus();
      const rules = bindings(command);

      expect(
        resolveShortcutCommand(keydown(focus.editor), rules, {
          platform: "Linux",
          context: { terminalFocus: false },
        }),
      ).toBeNull();
      expect(resolveShortcutCommand(keydown(focus.other), rules, { platform: "Linux" })).toBe(
        command,
      );
    },
  );

  it("uses the active element when a forwarded shortcut has no target", () => {
    using _focus = setupFocus();
    expect(
      resolveShortcutCommand(keydown(), bindings("commandPalette.toggle"), { platform: "Linux" }),
    ).toBeNull();
  });

  it("honors a positive editableFocus condition", () => {
    using focus = setupFocus();
    const rules = bindings("commandPalette.toggle", "editableFocus");
    expect(resolveShortcutCommand(keydown(focus.editor), rules, { platform: "Linux" })).toBe(
      "commandPalette.toggle",
    );
    expect(resolveShortcutCommand(keydown(focus.other), rules, { platform: "Linux" })).toBeNull();
  });

  it("preserves explicit focus overrides", () => {
    using focus = setupFocus();
    const rules = bindings("commandPalette.toggle");

    expect(
      resolveShortcutCommand(keydown(focus.editor), rules, {
        platform: "Linux",
        context: { editableFocus: false },
      }),
    ).toBe("commandPalette.toggle");
    expect(
      resolveShortcutCommand(keydown(focus.other), rules, {
        platform: "Linux",
        context: { editableFocus: true },
      }),
    ).toBeNull();
  });

  it("keeps shortcuts without an editable-focus condition active while editing", () => {
    using focus = setupFocus();
    expect(
      resolveShortcutCommand(keydown(focus.editor), bindings("commandPalette.toggle", "true"), {
        platform: "Linux",
      }),
    ).toBe("commandPalette.toggle");
  });
});
