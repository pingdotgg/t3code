import { describe, expect, it } from "vite-plus/test";

import { makePreviewAutomationKeySequence } from "./PreviewKeyboard.ts";

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
    expect(makePreviewAutomationKeySequence({ key: "a", modifiers: ["Meta"] }).keyDown).toEqual({
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      modifiers: 4,
      windowsVirtualKeyCode: 65,
      location: 0,
      isKeypad: false,
    });
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
});
