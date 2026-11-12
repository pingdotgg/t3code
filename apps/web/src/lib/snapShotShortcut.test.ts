import { describe, expect, it } from "vite-plus/test";

import {
  formatSnapShotShortcutLabel,
  parseDesktopSnapShotShortcut,
  snapShotShortcutKeyLabels,
} from "./snapShotShortcut";

describe("desktop-approved window capture shortcut labels", () => {
  it.each([
    ["Press <Shift><Control>2", ["Ctrl", "⇧", "2"]],
    ["Ctrl+Shift+8", ["Ctrl", "⇧", "8"]],
    ["Meta+F12", ["Super", "F12"]],
    ["<Primary><Alt>Return", ["Ctrl", "Alt", "Enter"]],
    ["<Super>Left", ["Super", "Left"]],
    ["<Control>space", ["Ctrl", "Space"]],
    ["<Control>plus", ["Ctrl", "+"]],
    ["Ctrl++", ["Ctrl", "+"]],
  ])("formats %s using the shared keycap labels", (label, expected) => {
    const shortcut = parseDesktopSnapShotShortcut(label);
    expect(shortcut).not.toBeNull();
    expect(snapShotShortcutKeyLabels(shortcut!, "Linux")).toEqual(expected);
  });

  it.each([
    "",
    "Ctrl+",
    "Press the shortcut configured in your desktop",
    "<Unknown>2",
    "<Control>UnknownKey",
  ])("does not guess keys from an unrecognized description: %s", (label) => {
    expect(parseDesktopSnapShotShortcut(label)).toBeNull();
  });
});

describe("modifier-pair shortcut labels", () => {
  it("names the left and right key instead of repeating the modifier", () => {
    expect(formatSnapShotShortcutLabel({ kind: "both-shift-keys" }, "MacIntel")).toBe(
      "Left Shift + Right Shift",
    );
    expect(
      snapShotShortcutKeyLabels({ kind: "modifier-pair", modifier: "meta" }, "MacIntel"),
    ).toEqual(["Left ⌘", "Right ⌘"]);
  });
});
