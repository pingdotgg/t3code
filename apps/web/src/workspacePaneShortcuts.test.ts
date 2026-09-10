import { describe, expect, it } from "vite-plus/test";

import { workspacePaneShortcutAction } from "./workspacePaneShortcuts";

describe("workspacePaneShortcutAction", () => {
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
});
