import { MAX_KEYBINDING_VALUE_LENGTH, type KeybindingCommand } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { commandForProjectScript } from "../projectScripts";
import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
  keybindingValuesForCommand,
  PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE,
  syncProjectScriptKeybinding,
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

  it("reads all matching keybinding values for a command", () => {
    const command = commandForProjectScript("test");
    const values = keybindingValuesForCommand(
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

    expect(values).toEqual(["mod+esc", "mod+shift+k"]);
  });

  it("removes existing command keybindings when clearing a script keybinding", async () => {
    const command = commandForProjectScript("test");
    const server = {
      removeKeybinding: vi.fn(async () => ({ keybindings: [], issues: [] })),
      upsertKeybinding: vi.fn(async () => ({ keybindings: [], issues: [] })),
    };

    await syncProjectScriptKeybinding({
      keybindings: [
        {
          command,
          shortcut: {
            key: "j",
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
            shiftKey: false,
            altKey: false,
            modKey: true,
          },
        },
      ],
      keybinding: null,
      command,
      server,
    });

    expect(server.removeKeybinding).toHaveBeenCalledTimes(2);
    expect(server.removeKeybinding).toHaveBeenNthCalledWith(1, {
      key: "mod+j",
      command,
    });
    expect(server.removeKeybinding).toHaveBeenNthCalledWith(2, {
      key: "mod+k",
      command,
    });
    expect(server.upsertKeybinding).not.toHaveBeenCalled();
  });

  it("skips validation when no keybinding server is available", async () => {
    await expect(
      syncProjectScriptKeybinding({
        keybindings: [],
        keybinding: "k".repeat(MAX_KEYBINDING_VALUE_LENGTH + 1),
        command: commandForProjectScript("test"),
        server: null,
      }),
    ).resolves.toBeUndefined();
  });

  it("removes stale command keybindings before saving the replacement", async () => {
    const command = commandForProjectScript("test");
    const server = {
      removeKeybinding: vi.fn(async () => ({ keybindings: [], issues: [] })),
      upsertKeybinding: vi.fn(async () => ({ keybindings: [], issues: [] })),
    };

    await syncProjectScriptKeybinding({
      keybindings: [
        {
          command,
          shortcut: {
            key: "j",
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
            modKey: true,
          },
        },
      ],
      keybinding: "mod+k",
      command,
      server,
    });

    expect(server.removeKeybinding).toHaveBeenCalledWith({
      key: "mod+j",
      command,
    });
    expect(server.upsertKeybinding).toHaveBeenCalledWith({
      key: "mod+k",
      command,
    });
  });
});
