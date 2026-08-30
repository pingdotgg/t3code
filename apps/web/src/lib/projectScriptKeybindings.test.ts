import { MAX_KEYBINDING_VALUE_LENGTH, type KeybindingCommand } from "@t3tools/contracts";
import { compileResolvedKeybindingRule } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { resolveShortcutCommand } from "../keybindings";
import { commandForProjectScript } from "../projectScripts";
import {
  decodeProjectScriptKeybindingRule,
  deriveProjectScriptKeybindingMutations,
  keybindingValueForCommand,
  mergeProjectScriptKeybindings,
  PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE,
} from "./projectScriptKeybindings";

function resolvedBinding(command: KeybindingCommand, key: string, when?: string) {
  const binding = compileResolvedKeybindingRule({ key, command, ...(when ? { when } : {}) });
  if (!binding) throw new Error("Invalid test keybinding");
  return binding;
}

describe("projectScriptKeybindings", () => {
  it("decodes and trims valid keybinding rules", () => {
    const rule = decodeProjectScriptKeybindingRule({
      keybinding: "  mod+k  ",
      command: commandForProjectScript("lint"),
    });

    expect(rule).toEqual({
      key: "mod+k",
      command: "script.lint.run",
    });
  });

  it("returns null when keybinding is empty", () => {
    expect(
      decodeProjectScriptKeybindingRule({
        keybinding: "   ",
        command: commandForProjectScript("lint"),
      }),
    ).toBeNull();
  });

  it("rejects invalid keybinding values", () => {
    expect(() =>
      decodeProjectScriptKeybindingRule({
        keybinding: "k".repeat(MAX_KEYBINDING_VALUE_LENGTH + 1),
        command: commandForProjectScript("lint"),
      }),
    ).toThrowError(PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE);
  });

  it("rejects invalid commands", () => {
    expect(() =>
      decodeProjectScriptKeybindingRule({
        keybinding: "mod+k",
        command: "script.BAD.run" as KeybindingCommand,
      }),
    ).toThrowError(PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE);
  });

  it("reads latest matching keybinding value for a command", () => {
    const command = commandForProjectScript("test");
    const value = keybindingValueForCommand(
      [
        {
          command,
          shortcut: {
            key: "escape",
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
            modKey: true,
          },
        },
        {
          command,
          shortcut: {
            key: "k",
            metaKey: false,
            ctrlKey: false,
            shiftKey: true,
            altKey: false,
            modKey: true,
          },
        },
      ],
      command,
    );

    expect(value).toBe("mod+shift+k");
  });

  it("removes every stale binding when changing or clearing a shortcut", () => {
    const command = commandForProjectScript("test");
    const compactWhen = Array.from({ length: 38 }, (_, index) => `v${index}`).join("&&");
    const keybindings = [
      resolvedBinding(command, "mod+r"),
      resolvedBinding(command, "mod+alt+r", compactWhen),
    ];
    const targets = [
      { key: "mod+r", command },
      { key: "mod+alt+r", command, when: compactWhen },
    ];

    expect(
      deriveProjectScriptKeybindingMutations({
        keybindings,
        keybinding: "mod+shift+r",
        command,
      }),
    ).toEqual([
      { type: "remove", input: targets[0] },
      {
        type: "upsert",
        input: {
          key: "mod+shift+r",
          command,
          replace: targets[1],
        },
      },
    ]);

    expect(
      deriveProjectScriptKeybindingMutations({
        keybindings,
        keybinding: null,
        command,
      }),
    ).toEqual(targets.map((input) => ({ type: "remove", input })));
  });

  it("lets routed script bindings override primary commands", () => {
    const command = commandForProjectScript("test");
    const keybindings = mergeProjectScriptKeybindings(
      [resolvedBinding("sidebar.toggle", "mod+b"), resolvedBinding(command, "mod+r")],
      [resolvedBinding(command, "mod+b")],
    );

    expect(
      resolveShortcutCommand(
        { key: "b", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
        keybindings,
        { platform: "Linux" },
      ),
    ).toBe(command);
  });
});
