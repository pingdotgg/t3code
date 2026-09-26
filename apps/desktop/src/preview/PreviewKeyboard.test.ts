import { describe, expect, it } from "vite-plus/test";

import {
  makePreviewAutomationKeySequence,
  makePreviewAutomationNativeKeySequence,
} from "./PreviewKeyboard.ts";

describe("preview keyboard packets", () => {
  it("includes the Chromium virtual key code and Enter text", () => {
    expect(makePreviewAutomationKeySequence({ key: "Enter" })).toEqual({
      keyDown: {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        modifiers: 0,
        windowsVirtualKeyCode: 13,
        location: 0,
        isKeypad: false,
        text: "\r",
        unmodifiedText: "\r",
      },
      keyUp: {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        modifiers: 0,
        windowsVirtualKeyCode: 13,
        location: 0,
        isKeypad: false,
      },
      signal: { kind: "key", key: "Enter", code: "Enter" },
    });
  });

  it("dispatches printable keys as text key-down events", () => {
    const sequence = makePreviewAutomationKeySequence({ key: "z" });
    expect(sequence.keyDown).toMatchObject({
      type: "keyDown",
      key: "z",
      code: "KeyZ",
      windowsVirtualKeyCode: 90,
      text: "z",
    });
    expect(sequence.keyUp).not.toHaveProperty("text");
  });

  it("suppresses text and uses raw key-down for shortcuts", () => {
    expect(
      makePreviewAutomationKeySequence({ key: "a", modifiers: ["Meta"] }, { isMac: true }).keyDown,
    ).toEqual({
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      modifiers: 4,
      windowsVirtualKeyCode: 65,
      location: 0,
      isKeypad: false,
      commands: ["selectAll"],
    });
  });

  it("maps common macOS editing shortcuts without changing other platforms", () => {
    expect(
      makePreviewAutomationKeySequence({ key: "z", modifiers: ["Shift", "Meta"] }, { isMac: true })
        .keyDown.commands,
    ).toEqual(["redo"]);
    expect(
      makePreviewAutomationKeySequence({ key: "a", modifiers: ["Meta"] }).keyDown,
    ).not.toHaveProperty("commands");
  });

  it("resolves shifted printable keys to their browser values", () => {
    const sequence = makePreviewAutomationKeySequence({ key: "1", modifiers: ["Shift"] });
    expect(sequence.keyDown).toMatchObject({
      key: "!",
      code: "Digit1",
      modifiers: 8,
      windowsVirtualKeyCode: 49,
      text: "!",
    });
    expect(sequence.signal).toEqual({ kind: "key", key: "!", code: "Digit1" });
  });

  it("keeps shifted key values while suppressing text for modified chords", () => {
    const sequence = makePreviewAutomationKeySequence({
      key: "1",
      modifiers: ["Control", "Shift"],
    });
    expect(sequence.keyDown).toEqual({
      type: "rawKeyDown",
      key: "!",
      code: "Digit1",
      modifiers: 10,
      windowsVirtualKeyCode: 49,
      location: 0,
      isKeypad: false,
    });
    expect(sequence.signal).toEqual({ kind: "key", key: "!", code: "Digit1" });
  });

  it.each([
    ["Enter", "\r"],
    ["z", "z"],
  ])("converts %s into native down, char, and up packets", (key, text) => {
    const sequence = makePreviewAutomationNativeKeySequence({ key });
    const shared = { keyCode: key, modifiers: [], skipIfUnhandled: true };
    expect(sequence.keyDown).toEqual({ type: "keyDown", ...shared });
    expect(sequence.char).toEqual({ type: "char", ...shared, keyCode: text });
    expect(sequence.keyUp).toEqual({ type: "keyUp", ...shared });
  });

  it("suppresses text for shortcuts and retains macOS editing commands", () => {
    const sequence = makePreviewAutomationNativeKeySequence(
      { key: "a", modifiers: ["Meta"] },
      { isMac: true },
    );
    expect(sequence.keyDown).toEqual({
      type: "keyDown",
      keyCode: "a",
      modifiers: ["meta"],
      skipIfUnhandled: true,
    });
    expect(sequence.char).toBeUndefined();
    expect(sequence.commands).toEqual(["selectAll"]);
  });

  it.each([
    ["ArrowLeft", "Left"],
    ["ArrowRight", "Right"],
    ["ArrowUp", "Up"],
    ["ArrowDown", "Down"],
  ])("maps %s to Electron's %s accelerator", (key, keyCode) => {
    const sequence = makePreviewAutomationNativeKeySequence({ key });
    expect(sequence.keyDown.keyCode).toBe(keyCode);
    expect(sequence.keyUp.keyCode).toBe(keyCode);
    expect(sequence.signal.key).toBe(key);
    expect(sequence.char).toBeUndefined();
  });

  it("matches native uppercase key signals without inventing shortcut modifiers", () => {
    const plain = makePreviewAutomationNativeKeySequence({ key: "X" });
    expect(plain.signal).toEqual({ kind: "key", key: "x", code: "KeyX" });
    expect(plain.char?.keyCode).toBe("X");
    const shortcut = makePreviewAutomationNativeKeySequence({ key: "A", modifiers: ["Control"] });
    expect(shortcut.signal).toEqual({ kind: "key", key: "a", code: "KeyA" });
    expect(shortcut.keyDown.modifiers).toEqual(["control"]);
    expect(shortcut.char).toBeUndefined();
    expect(
      makePreviewAutomationNativeKeySequence({ key: "X", modifiers: ["Shift"] }).signal,
    ).toEqual({
      kind: "key",
      key: "X",
      code: "KeyX",
    });
  });

  it("matches native signals for Unicode text and literal spaces", () => {
    const unicode = makePreviewAutomationNativeKeySequence({ key: "é" });
    expect(unicode.signal).toEqual({ kind: "key", key: "", code: "" });
    expect(unicode.char?.keyCode).toBe("é");
    expect(makePreviewAutomationNativeKeySequence({ key: " " }).signal).toEqual({
      kind: "key",
      key: " ",
      code: "Space",
    });
  });

  it("preserves text and editing commands for isolated child renderer targets", () => {
    const text = makePreviewAutomationKeySequence({ key: "é" });
    expect(text.keyDown).toMatchObject({ type: "keyDown", text: "é", key: "é" });
    expect(text.keyUp).toMatchObject({ type: "keyUp", key: "é" });
    const shortcut = makePreviewAutomationKeySequence(
      { key: "a", modifiers: ["Meta"] },
      { isMac: true },
    );
    expect(shortcut.keyDown).toMatchObject({
      type: "rawKeyDown",
      modifiers: 4,
      commands: ["selectAll"],
    });
    expect(shortcut.keyDown).not.toHaveProperty("text");
    expect(shortcut.keyDown).not.toHaveProperty("nativeVirtualKeyCode");
  });
});
