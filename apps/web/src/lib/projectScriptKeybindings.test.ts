import { MAX_KEYBINDING_VALUE_LENGTH, type KeybindingCommand } from "@t3tools/contracts";
import { compileResolvedKeybindingRule } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { commandForProjectScript } from "../projectScripts";
import {
  decodeProjectScriptKeybindingRule,
  deriveProjectScriptKeybindingMutations,
  keybindingValueForCommand,
  PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE,
} from "./projectScriptKeybindings";

function resolvedBinding(command: KeybindingCommand, keybinding: string, when?: string) {
  const binding = compileResolvedKeybindingRule({
    key: keybinding,
    command,
    ...(when ? { when } : {}),
  });
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
      [resolvedBinding(command, "mod+esc"), resolvedBinding(command, "mod+shift+k")],
      command,
    );

    expect(value).toBe("mod+shift+k");
  });

  it("replaces the previous keybinding when a script keybinding changes", () => {
    const command = commandForProjectScript("test");

    expect(
      deriveProjectScriptKeybindingMutations({
        keybindings: [resolvedBinding(command, "mod+r")],
        keybinding: "mod+shift+r",
        command,
      }),
    ).toEqual([
      {
        type: "upsert",
        input: {
          key: "mod+shift+r",
          command,
          replace: { key: "mod+r", command },
        },
      },
    ]);
  });

  it("removes every stale keybinding and preserves the latest condition when replacing", () => {
    const command = commandForProjectScript("test");

    expect(
      deriveProjectScriptKeybindingMutations({
        keybindings: [
          resolvedBinding(command, "mod+r"),
          resolvedBinding(command, "mod+alt+r", "terminalFocus"),
        ],
        keybinding: "mod+shift+r",
        command,
      }),
    ).toEqual([
      {
        type: "remove",
        input: { key: "mod+r", command },
      },
      {
        type: "upsert",
        input: {
          key: "mod+shift+r",
          command,
          replace: { key: "mod+alt+r", command, when: "terminalFocus" },
        },
      },
    ]);
  });

  it("removes every stale keybinding when a script keybinding is cleared", () => {
    const command = commandForProjectScript("test");

    expect(
      deriveProjectScriptKeybindingMutations({
        keybindings: [
          resolvedBinding(command, "mod+r"),
          resolvedBinding(command, "mod+shift+r", "terminalFocus"),
        ],
        keybinding: null,
        command,
      }),
    ).toEqual([
      {
        type: "remove",
        input: { key: "mod+r", command },
      },
      {
        type: "remove",
        input: { key: "mod+shift+r", command, when: "terminalFocus" },
      },
    ]);
  });
});
