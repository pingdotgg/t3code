import { describe, expect, it } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";

import {
  isWorkspaceShortcutReleasedFromTerminal,
  workspacePaneShortcutAction,
} from "./workspacePaneShortcuts";

describe("workspacePaneShortcutAction", () => {
  it.each(["MacIntel", "Win32", "Linux x86_64"])(
    "releases maximize and restore while the terminal owns focus on %s",
    (platform) => {
      expect(
        isWorkspaceShortcutReleasedFromTerminal(
          {
            key: "Enter",
            metaKey: platform === "MacIntel",
            ctrlKey: platform !== "MacIntel",
            shiftKey: true,
            altKey: false,
          },
          DEFAULT_RESOLVED_KEYBINDINGS,
          { platform, context: { terminalFocus: true, terminalOpen: true } },
        ),
      ).toBe(true);
    },
  );

  it.each(["pane.toggleMaximized", "rightPanel.toggleMaximized"] as const)(
    "releases a custom %s binding from the terminal",
    (command) => {
      expect(
        isWorkspaceShortcutReleasedFromTerminal(
          { key: "m", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false },
          compileResolvedKeybindingsConfig([{ key: "mod+shift+m", command }]),
          { platform: "MacIntel", context: { terminalFocus: true, terminalOpen: true } },
        ),
      ).toBe(true);
    },
  );

  it("keeps ordinary Enter in the terminal", () => {
    expect(
      isWorkspaceShortcutReleasedFromTerminal(
        { key: "Enter", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
        DEFAULT_RESOLVED_KEYBINDINGS,
        { platform: "MacIntel", context: { terminalFocus: true, terminalOpen: true } },
      ),
    ).toBe(false);
  });

  it.each([
    ["pane.splitLeft", "left"],
    ["pane.splitDown", "down"],
    ["pane.splitUp", "up"],
    ["pane.splitRight", "right"],
  ] as const)("maps %s to a split", (command, direction) => {
    expect(workspacePaneShortcutAction(command)).toEqual({ _tag: "Split", direction });
  });

  it.each([
    ["pane.focusLeft", "left"],
    ["pane.focusDown", "down"],
    ["pane.focusUp", "up"],
    ["pane.focusRight", "right"],
  ] as const)("maps %s to directional focus", (command, direction) => {
    expect(workspacePaneShortcutAction(command)).toEqual({ _tag: "Focus", direction });
  });

  it("maps pane maximization and ignores unrelated commands", () => {
    expect(workspacePaneShortcutAction("pane.toggleMaximized")).toEqual({
      _tag: "ToggleMaximized",
    });
    expect(workspacePaneShortcutAction("terminal.toggle")).toBeNull();
  });

  it("recognizes directional pane focus while the terminal owns focus", () => {
    expect(
      isWorkspaceShortcutReleasedFromTerminal(
        {
          key: "l",
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: true,
        },
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "MacIntel",
          context: { terminalFocus: true, terminalOpen: true },
        },
      ),
    ).toBe(true);
  });

  it("does not release pane split shortcuts from the terminal", () => {
    expect(
      isWorkspaceShortcutReleasedFromTerminal(
        {
          key: "l",
          metaKey: true,
          ctrlKey: false,
          shiftKey: true,
          altKey: false,
        },
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "MacIntel",
          context: { terminalFocus: true, terminalOpen: true },
        },
      ),
    ).toBe(false);
  });

  it("releases the right sidebar toggle from the terminal", () => {
    expect(
      isWorkspaceShortcutReleasedFromTerminal(
        {
          key: "b",
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: true,
        },
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "MacIntel",
          context: { terminalFocus: true, terminalOpen: true },
        },
      ),
    ).toBe(true);
  });
});
