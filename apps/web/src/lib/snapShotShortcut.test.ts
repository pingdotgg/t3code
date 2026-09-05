import { describe, expect, it } from "vite-plus/test";

import {
  formatSnapShotShortcutLabel,
  parseDesktopSnapShotShortcut,
  sameSnapShotShortcut,
  snapShotKeybindingConflict,
  snapShotShortcutKeyLabels,
} from "./snapShotShortcut";

describe("desktop-approved window capture shortcut labels", () => {
  it.each([
    ["Press <Shift><Control>2", ["Ctrl", "⇧", "2"]],
    ["<Control><Shift>2", ["Ctrl", "⇧", "2"]],
    ["Ctrl+Shift+8", ["Ctrl", "⇧", "8"]],
    ["CTRL+SHIFT+8", ["Ctrl", "⇧", "8"]],
    ["Meta+F12", ["Super", "F12"]],
    ["Super+F8", ["Super", "F8"]],
    ["<Primary><Alt>Return", ["Ctrl", "Alt", "Enter"]],
    ["<Super>Left", ["Super", "Left"]],
    ["<Control>space", ["Ctrl", "Space"]],
    ["<Control>plus", ["Ctrl", "+"]],
    ["<Control>+", ["Ctrl", "+"]],
    ["Ctrl++", ["Ctrl", "+"]],
    ["  Ctrl + Shift + 2  ", ["Ctrl", "⇧", "2"]],
  ])("formats %s using the shared keycap labels", (label, expected) => {
    const shortcut = parseDesktopSnapShotShortcut(label);
    expect(shortcut).not.toBeNull();
    expect(snapShotShortcutKeyLabels(shortcut!, "Linux")).toEqual(expected);
  });

  it.each([
    "",
    " ",
    "Press ",
    "Ctrl+",
    "Press the shortcut configured in your desktop",
    "Ctrl+Shift+2 or Ctrl+Shift+3",
    "Press <Control>2 or <Control>3",
    "<Unknown>2",
    "<Control>",
    "<Control>UnknownKey",
  ])("does not guess keys from an unrecognized description: %s", (label) => {
    expect(parseDesktopSnapShotShortcut(label)).toBeNull();
  });
});

describe("window capture shortcut labels", () => {
  it("labels the default physical Shift pair", () => {
    expect(formatSnapShotShortcutLabel({ kind: "both-shift-keys" }, "MacIntel")).toBe(
      "Shift + Shift",
    );
  });

  it("labels other modifier pairs per platform", () => {
    expect(
      formatSnapShotShortcutLabel({ kind: "modifier-pair", modifier: "meta" }, "MacIntel"),
    ).toBe("Command + Command");
    expect(formatSnapShotShortcutLabel({ kind: "modifier-pair", modifier: "meta" }, "Linux")).toBe(
      "Super + Super",
    );
    expect(
      formatSnapShotShortcutLabel({ kind: "modifier-pair", modifier: "alt" }, "MacIntel"),
    ).toBe("Option + Option");
  });

  it.each([
    ["MacIntel", { kind: "modifier-pair", modifier: "meta" } as const, ["⌘", "⌘"]],
    ["MacIntel", { kind: "both-shift-keys" } as const, ["⇧", "⇧"]],
    ["MacIntel", { kind: "modifier-pair", modifier: "alt" } as const, ["⌥", "⌥"]],
    ["MacIntel", { kind: "modifier-pair", modifier: "control" } as const, ["⌃", "⌃"]],
    ["Win32", { kind: "modifier-pair", modifier: "meta" } as const, ["⊞", "⊞"]],
    ["Win32", { kind: "both-shift-keys" } as const, ["⇧", "⇧"]],
    ["Win32", { kind: "modifier-pair", modifier: "alt" } as const, ["Alt", "Alt"]],
    ["Win32", { kind: "modifier-pair", modifier: "control" } as const, ["Ctrl", "Ctrl"]],
    ["Linux", { kind: "modifier-pair", modifier: "meta" } as const, ["Super", "Super"]],
    ["Linux", { kind: "both-shift-keys" } as const, ["⇧", "⇧"]],
    ["Linux", { kind: "modifier-pair", modifier: "alt" } as const, ["Alt", "Alt"]],
    ["Linux", { kind: "modifier-pair", modifier: "control" } as const, ["Ctrl", "Ctrl"]],
  ])("renders modifier-pair key caps on %s", (platform, shortcut, expected) => {
    expect(snapShotShortcutKeyLabels(shortcut, platform)).toEqual(expected);
  });

  it.each([
    ["MacIntel", ["⇧", "⌘", "2"]],
    ["Win32", ["Ctrl", "⇧", "2"]],
    ["Linux", ["Ctrl", "⇧", "2"]],
  ])("renders chord key caps on %s", (platform, expected) => {
    expect(
      snapShotShortcutKeyLabels(
        {
          key: "2",
          metaKey: false,
          ctrlKey: false,
          shiftKey: true,
          altKey: false,
          modKey: true,
        },
        platform,
      ),
    ).toEqual(expected);
  });
});

describe("window capture keybinding conflicts", () => {
  it("finds an effective T3 Code keybinding on the current platform", () => {
    expect(
      snapShotKeybindingConflict(
        {
          key: "n",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
        [
          {
            command: "chat.new",
            shortcut: {
              key: "n",
              metaKey: true,
              ctrlKey: false,
              shiftKey: false,
              altKey: false,
              modKey: false,
            },
          },
        ],
        "MacIntel",
      ),
    ).toBe("chat.new");
  });

  it("does not conflict with regular keybindings for both Shift keys", () => {
    expect(snapShotKeybindingConflict({ kind: "both-shift-keys" }, [], "Linux")).toBeNull();
  });

  it("keeps symbols on different physical keys distinct", () => {
    const modifiers = {
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      modKey: true,
    } as const;

    expect(
      snapShotKeybindingConflict(
        { key: '"', ...modifiers },
        [
          {
            command: "capture.other",
            shortcut: { key: "'", ...modifiers },
          },
        ],
        "MacIntel",
      ),
    ).toBeNull();
  });
});

describe("sameSnapShotShortcut", () => {
  it("compares the physical Shift pair and platform-equivalent chords", () => {
    expect(
      sameSnapShotShortcut({ kind: "both-shift-keys" }, { kind: "both-shift-keys" }, "MacIntel"),
    ).toBe(true);
    expect(
      sameSnapShotShortcut(
        { kind: "both-shift-keys" },
        { kind: "modifier-pair", modifier: "shift" },
        "MacIntel",
      ),
    ).toBe(true);
    expect(
      sameSnapShotShortcut(
        { kind: "modifier-pair", modifier: "meta" },
        { kind: "both-shift-keys" },
        "MacIntel",
      ),
    ).toBe(false);
    expect(
      sameSnapShotShortcut(
        { key: "n", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: true },
        { key: "n", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, modKey: false },
        "MacIntel",
      ),
    ).toBe(true);
  });
});
