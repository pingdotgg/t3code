import { describe, expect, it } from "vite-plus/test";

import {
  HARDWARE_KEYBOARD_SHORTCUT_BINDINGS,
  matchHardwareKeyboardShortcut,
} from "./hardwareKeyboardShortcutBindings";

describe("HARDWARE_KEYBOARD_SHORTCUT_BINDINGS", () => {
  it("defines the thread tool and navigation shortcuts", () => {
    const commands = HARDWARE_KEYBOARD_SHORTCUT_BINDINGS.map((binding) => binding.command);
    expect(commands).toContain("newTask");
    expect(commands).toContain("focusSearch");
    expect(commands).toContain("back");
    expect(commands).toContain("files");
    expect(commands).toContain("terminal");
    expect(commands).toContain("review");
    expect(commands).toContain("toggleSidebar");
  });
});

describe("matchHardwareKeyboardShortcut", () => {
  it("maps ctrl+n to newTask", () => {
    expect(matchHardwareKeyboardShortcut("n", { ctrl: true })).toBe("newTask");
  });

  it("maps ctrl+f and ctrl+k to focusSearch", () => {
    expect(matchHardwareKeyboardShortcut("f", { ctrl: true })).toBe("focusSearch");
    expect(matchHardwareKeyboardShortcut("k", { ctrl: true })).toBe("focusSearch");
  });

  it("maps ctrl+[ to back", () => {
    expect(matchHardwareKeyboardShortcut("[", { ctrl: true })).toBe("back");
  });

  it("maps ctrl+shift thread tool shortcuts", () => {
    expect(matchHardwareKeyboardShortcut("f", { ctrl: true, shift: true })).toBe("files");
    expect(matchHardwareKeyboardShortcut("t", { ctrl: true, shift: true })).toBe("terminal");
    expect(matchHardwareKeyboardShortcut("r", { ctrl: true, shift: true })).toBe("review");
  });

  it("maps ctrl+\\ to toggleSidebar", () => {
    expect(matchHardwareKeyboardShortcut("\\", { ctrl: true })).toBe("toggleSidebar");
  });

  it("ignores shortcuts without ctrl", () => {
    expect(matchHardwareKeyboardShortcut("n", { ctrl: false })).toBeNull();
    expect(matchHardwareKeyboardShortcut("f", { ctrl: false, shift: true })).toBeNull();
  });

  it("distinguishes ctrl+f from ctrl+shift+f", () => {
    expect(matchHardwareKeyboardShortcut("f", { ctrl: true })).toBe("focusSearch");
    expect(matchHardwareKeyboardShortcut("f", { ctrl: true, shift: true })).toBe("files");
  });
});
