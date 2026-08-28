import { describe, expect, it } from "vite-plus/test";

import { makePreviewAutomationKeySequence } from "./PreviewKeyboard.ts";

const expectedSignal = (key: string, code: string, modifiers: ReadonlyArray<string>) => ({
  kind: "key" as const,
  key,
  code,
  meta: modifiers.includes("meta"),
  shift: modifiers.includes("shift"),
  control: modifiers.includes("control"),
  alt: modifiers.includes("alt"),
});

const expectedSignals = (
  key: string,
  code: string,
  keyDownModifiers: ReadonlyArray<string>,
  keyUpModifiers = keyDownModifiers,
) => ({
  keyDownSignal: expectedSignal(key, code, keyDownModifiers),
  keyUpSignal: expectedSignal(key, code, keyUpModifiers),
});

describe("preview keyboard packets", () => {
  it("sends Enter with a carriage-return char packet", () => {
    expect(makePreviewAutomationKeySequence({ key: "Enter" })).toEqual({
      keyDown: { type: "rawKeyDown", keyCode: "Enter", modifiers: [] },
      char: { type: "char", keyCode: "\r", modifiers: [] },
      keyUp: { type: "keyUp", keyCode: "Enter", modifiers: [] },
      ...expectedSignals("Enter", "Enter", []),
    });
  });

  it("keeps Shift on every Shift+Enter packet", () => {
    expect(makePreviewAutomationKeySequence({ key: "Enter", modifiers: ["Shift"] })).toEqual({
      keyDown: { type: "rawKeyDown", keyCode: "Enter", modifiers: ["shift"] },
      char: { type: "char", keyCode: "\r", modifiers: ["shift"] },
      keyUp: { type: "keyUp", keyCode: "Enter", modifiers: ["shift"] },
      ...expectedSignals("Enter", "Enter", ["shift"]),
    });
  });

  for (const modifier of ["Control", "Alt", "Meta"] as const) {
    it(`suppresses Enter text for ${modifier} chords`, () => {
      const nativeModifier = modifier.toLowerCase();
      expect(makePreviewAutomationKeySequence({ key: "Enter", modifiers: [modifier] })).toEqual({
        keyDown: { type: "rawKeyDown", keyCode: "Enter", modifiers: [nativeModifier] },
        keyUp: { type: "keyUp", keyCode: "Enter", modifiers: [nativeModifier] },
        ...expectedSignals("Enter", "Enter", [nativeModifier]),
      });
    });
  }

  const namedModifiers = [
    { key: "Shift", code: "ShiftLeft", modifier: "shift" },
    { key: "Control", code: "ControlLeft", modifier: "control" },
    { key: "Alt", code: "AltLeft", modifier: "alt" },
    { key: "Meta", code: "MetaLeft", modifier: "meta" },
  ] as const;

  for (const { key, code, modifier } of namedModifiers) {
    it(`sets and clears the ${key} flag when pressing the named modifier`, () => {
      expect(makePreviewAutomationKeySequence({ key })).toEqual({
        keyDown: { type: "rawKeyDown", keyCode: key, modifiers: [modifier] },
        keyUp: { type: "keyUp", keyCode: key, modifiers: [] },
        ...expectedSignals(key, code, [modifier], []),
      });
    });

    it(`preserves other modifiers and removes duplicate ${key} flags on key-up`, () => {
      const otherModifier = key === "Alt" ? "Control" : "Alt";
      const otherNativeModifier = otherModifier.toLowerCase();
      expect(
        makePreviewAutomationKeySequence({
          key,
          modifiers: [otherModifier, key, key],
        }),
      ).toEqual({
        keyDown: {
          type: "rawKeyDown",
          keyCode: key,
          modifiers: [otherNativeModifier, modifier],
        },
        keyUp: { type: "keyUp", keyCode: key, modifiers: [otherNativeModifier] },
        ...expectedSignals(key, code, [otherNativeModifier, modifier], [otherNativeModifier]),
      });
    });
  }

  it("separates printable key events from text insertion", () => {
    expect(makePreviewAutomationKeySequence({ key: "z" })).toEqual({
      keyDown: { type: "rawKeyDown", keyCode: "Z", modifiers: [] },
      char: { type: "char", keyCode: "z", modifiers: [] },
      keyUp: { type: "keyUp", keyCode: "Z", modifiers: [] },
      ...expectedSignals("z", "KeyZ", []),
    });
  });

  it("uses native modifier chords without inserting text", () => {
    expect(makePreviewAutomationKeySequence({ key: "a", modifiers: ["Meta"] })).toEqual({
      keyDown: { type: "rawKeyDown", keyCode: "A", modifiers: ["meta"] },
      keyUp: { type: "keyUp", keyCode: "A", modifiers: ["meta"] },
      ...expectedSignals("a", "KeyA", ["meta"]),
    });
  });

  it("keeps editing-chord modifiers on each native packet", () => {
    expect(makePreviewAutomationKeySequence({ key: "z", modifiers: ["Shift", "Meta"] })).toEqual({
      keyDown: { type: "rawKeyDown", keyCode: "Z", modifiers: ["shift", "meta"] },
      keyUp: { type: "keyUp", keyCode: "Z", modifiers: ["shift", "meta"] },
      ...expectedSignals("Z", "KeyZ", ["shift", "meta"]),
    });
  });

  it("maps shifted printable keys to a base key plus Shift", () => {
    expect(makePreviewAutomationKeySequence({ key: "!" })).toEqual({
      keyDown: { type: "rawKeyDown", keyCode: "1", modifiers: ["shift"] },
      char: { type: "char", keyCode: "!", modifiers: ["shift"] },
      keyUp: { type: "keyUp", keyCode: "1", modifiers: ["shift"] },
      ...expectedSignals("!", "Digit1", ["shift"]),
    });
  });

  it("does not insert text for modified shifted keys", () => {
    expect(makePreviewAutomationKeySequence({ key: "1", modifiers: ["Control", "Shift"] })).toEqual(
      {
        keyDown: {
          type: "rawKeyDown",
          keyCode: "1",
          modifiers: ["control", "shift"],
        },
        keyUp: { type: "keyUp", keyCode: "1", modifiers: ["control", "shift"] },
        ...expectedSignals("!", "Digit1", ["control", "shift"]),
      },
    );
  });

  it("uses Electron accelerator names for arrows and function keys", () => {
    expect(makePreviewAutomationKeySequence({ key: "ArrowLeft" }).keyDown.keyCode).toBe("Left");
    expect(makePreviewAutomationKeySequence({ key: "F12" }).keyDown.keyCode).toBe("F12");
  });

  it("uses a literal space only for the char packet", () => {
    expect(makePreviewAutomationKeySequence({ key: "Space" })).toEqual({
      keyDown: { type: "rawKeyDown", keyCode: "Space", modifiers: [] },
      char: { type: "char", keyCode: " ", modifiers: [] },
      keyUp: { type: "keyUp", keyCode: "Space", modifiers: [] },
      ...expectedSignals(" ", "Space", []),
    });
  });

  it("does not forward unchecked Unicode keys to Electron", () => {
    expect(() => makePreviewAutomationKeySequence({ key: "\u00e9" } as never)).toThrow(
      "Use preview_type for Unicode text.",
    );
  });
});
