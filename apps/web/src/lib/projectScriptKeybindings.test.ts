import { describe, expect, it } from "vite-plus/test";

import { commandForProjectScript } from "../projectScripts";
import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
  PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE,
} from "./projectScriptKeybindings";

describe("projectScriptKeybindings", () => {
  it("can edit or delete a legacy script without a shortcut", () => {
    const command = commandForProjectScript("install-javascript-dependencies");
    expect(keybindingValueForCommand([], command)).toBeNull();
    expect(decodeProjectScriptKeybindingRule({ keybinding: null, command })).toBeNull();
    expect(() => decodeProjectScriptKeybindingRule({ keybinding: "mod+k", command })).toThrowError(
      PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE,
    );
  });
});
