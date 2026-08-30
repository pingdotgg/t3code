import { MAX_KEYBINDING_VALUE_LENGTH, type KeybindingCommand } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { commandForProjectScript } from "../projectScripts";
import {
  decodeProjectScriptKeybindingRule,
  deriveProjectScriptKeybindingMutation,
  keybindingValueForCommand,
  PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE,
} from "./projectScriptKeybindings";

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

  it("replaces the previous keybinding when a script keybinding changes", () => {
    const command = commandForProjectScript("test");

    expect(
      deriveProjectScriptKeybindingMutation({
        keybindings: [
          {
            command,
            shortcut: {
              key: "r",
              metaKey: false,
              ctrlKey: false,
              shiftKey: false,
              altKey: false,
              modKey: true,
            },
          },
        ],
        keybinding: "mod+shift+r",
        command,
      }),
    ).toEqual({
      type: "upsert",
      input: {
        key: "mod+shift+r",
        command,
        replace: { key: "mod+r", command },
      },
    });
  });

  it("removes the previous keybinding when a script keybinding is cleared", () => {
    const command = commandForProjectScript("test");

    expect(
      deriveProjectScriptKeybindingMutation({
        keybindings: [
          {
            command,
            shortcut: {
              key: "r",
              metaKey: false,
              ctrlKey: false,
              shiftKey: false,
              altKey: false,
              modKey: true,
            },
          },
        ],
        keybinding: null,
        command,
      }),
    ).toEqual({
      type: "remove",
      input: { key: "mod+r", command },
    });
  });
});
